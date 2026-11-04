// Bridge sessions: real Claude Code sessions on this Mac. Each one is an interactive
// `claude --remote-control` process (agent/cli.ts), so it also shows in the Claude app and on
// claude.ai/code, and can be answered there. Each session keeps its Claude session id, so
// `claude --resume <id>` opens it in a terminal.
// State is saved to ~/.voice-bridge/state.json after every change.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliArgs, type CliEvent, CliProcess, hasTranscript } from "./cli.ts";
import { extractVoice, titleOf } from "./text.ts";

export type Status = "working" | "needs_you" | "done" | "failed" | "stopped";

export interface SessionRecord {
  name: string; // "my-app-1"
  title: string; // first words of the task
  project: string;
  cwd: string;
  status: Status;
  claudeSessionId?: string;
  forkFrom?: string; // Claude session id to fork on the first turn
  createdAt: number;
  updatedAt: number;
  voice?: string; // the session's own spoken summary of its last turn
  result?: string; // its last answer, without the VOICE line
  question?: { about: string; askedAt: number };
  queue: string[];
  turns: number;
  setup?: Setup;
}

/** How a session runs. Kept with the session, so follow-ups run the same way. */
export interface Setup {
  model?: string; // "opus", "sonnet", "haiku", "fable" or a full id
  effort?: string;
  helperModel?: string; // set → the session orchestrates "helper" subagents on this model
  helperEffort?: string;
}

export const ORCHESTRATE_APPEND = (helper: string) => `
You are the orchestrator for this task. Plan the work, then hand independent, well-defined parts to the
"helper" subagent (it runs on ${helper}), several in parallel when they do not touch the same files.
Give each helper a complete brief. Review and integrate what they return, and do the hard decisions yourself.`;

export function cliSetup(setup: Setup | undefined): { model?: string; effort?: string; agents?: Record<string, unknown>; append: string } {
  if (!setup) return { append: "" };
  return {
    ...(setup.model ? { model: setup.model } : {}),
    ...(setup.effort ? { effort: setup.effort } : {}),
    ...(setup.helperModel
      ? {
          agents: {
            helper: {
              description: "Helper for one independent, well-defined part of the task: build one piece, research, write tests. Give it a complete brief.",
              prompt: "You are a helper on a larger task. Do exactly the part you were given, check it works, and report back in a few lines: what you did, what is left, any problem.",
              model: setup.helperModel,
              ...(setup.helperEffort ? { effort: setup.helperEffort } : {}),
            },
          },
        }
      : {}),
    append: setup.helperModel ? ORCHESTRATE_APPEND(setup.helperModel) : "",
  };
}

export const VOICE_APPEND = `
You run headless through a voice bridge: the user talks to you from their phone and does not see a screen.
Work on your own. Do not use AskUserQuestion; if you need a decision, finish the turn and ask in your final message.
End every final message with one line in this form:
VOICE: <at most two short spoken sentences: what you did, and what you need from the user, or "Nothing needed.">
Plain words in that line: no code, no file paths, no markdown.`;

/** What the manager needs from a running session. CliProcess in real use, a fake in tests. */
export interface SessionProcess {
  type(text: string): void;
  key(k: string): void;
}

export type SpawnFn = (cwd: string, args: CliArgs, onEvent: (e: CliEvent) => void, onExit: (code: number | null) => void) => SessionProcess;

export interface ManagerOptions {
  permissionMode?: string;
  model?: string;
  maxWorking?: number;
  eventsDir?: string; // where the hooks write each session's events
  spawn?: SpawnFn;
  hasTranscript?: (id: string) => boolean;
}

const NO_NOTE = "The user said no. Do not do that; find another way or stop and say why.";

export class SessionManager extends EventEmitter {
  sessions: SessionRecord[] = [];
  private counters: Record<string, number> = {};
  private procs = new Map<string, SessionProcess>();

  private statePath: string;
  private opts: ManagerOptions;
  private spawn: SpawnFn;

  constructor(statePath: string, opts: ManagerOptions = {}) {
    super();
    this.statePath = statePath;
    this.opts = opts;
    this.spawn = opts.spawn ?? ((cwd, args, onEvent, onExit) => new CliProcess(cwd, args, onEvent, onExit));
    this.load();
  }

  private load() {
    if (!existsSync(this.statePath)) return;
    let s: any;
    try {
      s = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch {
      // A broken state file must not crash-loop the agent: keep it aside and start empty.
      renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}`);
      return;
    }
    this.sessions = s.sessions ?? [];
    this.counters = s.counters ?? {};
    // Work that was running when the agent stopped is gone; the session itself can still be resumed.
    for (const r of this.sessions) {
      if (r.status === "working" || r.status === "needs_you") {
        r.status = "stopped";
        r.question = undefined;
        r.voice = "The bridge restarted while this was working. Send a message to carry on.";
      }
    }
  }

  private save() {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: this.sessions.slice(-200), counters: this.counters }, null, 1));
    renameSync(tmp, this.statePath);
    this.emit("change");
  }

  find(name: string): SessionRecord | undefined {
    const n = name.trim().toLowerCase();
    return this.sessions.find((s) => s.name === n);
  }

  /** Sessions doing work now: working, or waiting for the user. */
  working(): number {
    return this.sessions.filter((s) => this.procs.has(s.name) && this.busy(s)).length;
  }

  busy(rec: SessionRecord): boolean {
    return rec.status === "working" || rec.status === "needs_you";
  }

  start(p: { project: string; cwd: string; task: string; forkFrom?: string; setup?: Setup }): SessionRecord {
    if (this.working() >= (this.opts.maxWorking ?? 4)) {
      throw new Error(`${this.working()} sessions are already working. Wait for one to finish or stop one first.`);
    }
    const base = p.project.split("/").pop()!.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    this.counters[base] = (this.counters[base] ?? 0) + 1;
    const now = Date.now();
    const rec: SessionRecord = {
      name: `${base}-${this.counters[base]}`,
      title: titleOf(p.task),
      project: p.project,
      cwd: p.cwd,
      status: "working",
      forkFrom: p.forkFrom,
      createdAt: now,
      updatedAt: now,
      queue: [],
      turns: 0,
      ...(p.setup && Object.keys(p.setup).length ? { setup: p.setup } : {}),
    };
    this.sessions.push(rec);
    this.save();
    this.spawnSession(rec, p.task);
    return rec;
  }

  /** A follow-up: runs now, or after the current turn if it is still working. */
  send(rec: SessionRecord, text: string): "started" | "queued" {
    if (this.busy(rec)) {
      rec.queue.push(text);
      this.save();
      return "queued";
    }
    if (this.working() >= (this.opts.maxWorking ?? 4)) {
      throw new Error(`${this.working()} sessions are already working. Wait for one to finish first.`);
    }
    const proc = this.procs.get(rec.name);
    if (proc) {
      this.markWorking(rec);
      proc.type(text);
    } else {
      this.spawnSession(rec, text); // after a bridge restart: resume the same session
    }
    return "started";
  }

  answer(rec: SessionRecord, decision: "allow" | "deny", note?: string): boolean {
    const proc = this.procs.get(rec.name);
    if (!proc || rec.status !== "needs_you") return false;
    // The permission dialog: "1" is Yes; Esc is No, and Claude then waits for what to do instead.
    if (decision === "allow") proc.key("1");
    else {
      proc.key("\x1b");
      setTimeout(() => proc.type(note?.trim() || NO_NOTE), 800);
    }
    this.markWorking(rec);
    return true;
  }

  stop(rec: SessionRecord): boolean {
    rec.queue = [];
    const proc = this.procs.get(rec.name);
    if (!proc || !this.busy(rec)) return false;
    proc.key("\x1b"); // interrupt, like Esc in the terminal; the session stays open
    rec.status = "stopped";
    rec.question = undefined;
    rec.voice = "Stopped on the user's request.";
    rec.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** Resolves when the session stops working or needs the user, or after `ms`. */
  waitFor(rec: SessionRecord, ms: number): Promise<void> {
    if (rec.status !== "working" || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (rec.status !== "working") finish();
      };
      const finish = () => {
        clearTimeout(timer);
        this.off("change", done);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.on("change", done);
    });
  }

  private markWorking(rec: SessionRecord) {
    rec.status = "working";
    rec.question = undefined;
    rec.updatedAt = Date.now();
    this.save();
  }

  /** Start (or resume) the interactive process for a session, with its first message. */
  private spawnSession(rec: SessionRecord, prompt: string) {
    const saved = this.opts.hasTranscript ?? hasTranscript;
    // No saved transcript (the first start failed early): start fresh, with the same id.
    const fresh = !rec.claudeSessionId || !saved(rec.claudeSessionId);
    const sessionId = rec.claudeSessionId ?? randomUUID();
    const { append, ...setup } = cliSetup(rec.setup);
    const proc = this.spawn(
      rec.cwd,
      {
        name: `${rec.name}: ${rec.title}`.slice(0, 60),
        sessionId,
        prompt,
        resume: fresh ? rec.forkFrom : rec.claudeSessionId,
        fork: fresh && !!rec.forkFrom,
        permissionMode: this.opts.permissionMode ?? "auto",
        append: VOICE_APPEND + append,
        model: setup.model ?? this.opts.model,
        effort: setup.effort,
        agents: setup.agents,
        eventsFile: join(this.opts.eventsDir ?? join(dirname(this.statePath), "events"), `${rec.name}.jsonl`),
      },
      (e) => this.onEvent(rec, e),
      (code) => {
        if (this.procs.get(rec.name) === proc) this.procs.delete(rec.name);
        if (this.busy(rec)) {
          rec.status = "failed";
          rec.voice = `The session closed unexpectedly (code ${code}). Send a message to resume it.`;
        }
        rec.question = undefined;
        rec.updatedAt = Date.now();
        this.save();
      },
    );
    this.procs.set(rec.name, proc);
    rec.claudeSessionId = sessionId;
    rec.turns++;
    this.markWorking(rec);
  }

  private onEvent(rec: SessionRecord, e: CliEvent) {
    switch (e.hook_event_name) {
      case "UserPromptSubmit": // also when the user types on the phone or at claude.ai/code
        if (rec.status !== "working") rec.turns++;
        this.markWorking(rec);
        return;
      case "Notification":
        if (e.notification_type === "permission_prompt" || /permission/i.test(e.message ?? "")) {
          rec.status = "needs_you";
          const about = (e.message ?? "").replace(/^Claude needs your permission to\s*/i, "").replace(/\.$/, "");
          rec.question = { about: about || "do something", askedAt: Date.now() };
          rec.updatedAt = Date.now();
          this.save();
        }
        return;
      case "Stop": {
        if (rec.status === "stopped") return;
        const { voice, body } = extractVoice(String(e.last_assistant_message ?? ""));
        rec.voice = voice || "It finished without a summary.";
        rec.result = body;
        rec.status = "done";
        rec.question = undefined;
        rec.updatedAt = Date.now();
        this.save();
        const next = rec.queue.shift();
        if (next !== undefined) {
          this.markWorking(rec);
          this.procs.get(rec.name)?.type(next);
        }
        return;
      }
    }
  }
}

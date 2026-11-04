// The tools from shared/tools.ts, run on the Mac. Each returns a short spoken reply.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { type RepoState, scanAttention } from "./attention.ts";
import { type DesktopSession, folderLabel, kindLabel, lastWords, listDesktopSessions, listOtherSessions, transcriptPath } from "./desktop.ts";
import { gitAlias } from "./projects.ts";
import { listProjects, resolveProject } from "./projects.ts";
import type { SessionManager, SessionRecord, Setup } from "./sessions.ts";
import { ago, firstSentences, speakable } from "./text.ts";
import { MAX_WAIT_SECONDS } from "../shared/tools.ts";

export interface ToolDeps {
  manager: SessionManager;
  roots: string[];
  desktop?: () => DesktopSession[]; // tests pass their own
  repos?: (roots: string[]) => Promise<RepoState[]>;
}

type Ref = { kind: "bridge"; rec: SessionRecord } | { kind: "desktop"; d: DesktopSession };
export type Reply = { text: string; isError?: boolean };

const STATUS: Record<string, string> = {
  working: "working",
  needs_you: "needs you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

const MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** model / effort / helper_model / helper_effort from a tool call, checked. Throws a speakable error. */
export function parseSetup(args: Record<string, any>): Setup {
  const model = (v: unknown, what: string) => {
    if (v === undefined || v === null || v === "") return undefined;
    // Speech gives "Opus 5.5" or "sonnet five point five": the family name is what matters.
    const s = String(v).toLowerCase().trim();
    const alias = [...MODEL_ALIASES].find((a) => s.split(/[\s-]+/)[0] === a || s === a);
    if (alias && !/^claude-/.test(s)) return alias;
    if (/^claude-[a-z0-9.-]+$/.test(s)) return s;
    throw new Error(`I don't know the ${what} "${v}". Say opus, sonnet, haiku or fable.`);
  };
  const effort = (v: unknown, what: string) => {
    if (v === undefined || v === null || v === "") return undefined;
    const s = String(v).toLowerCase().replace(/[^a-z]/g, "").replace(/^extrahigh$/, "xhigh") as Setup["effort"];
    if (!EFFORTS.has(s!)) throw new Error(`The ${what} must be low, medium, high, extra high or max.`);
    return s;
  };
  const setup: Setup = {
    model: model(args.model, "model"),
    effort: effort(args.effort, "effort"),
    helperModel: model(args.helper_model, "helper model"),
    helperEffort: effort(args.helper_effort, "helper effort"),
  };
  for (const k of Object.keys(setup) as (keyof Setup)[]) if (setup[k] === undefined) delete setup[k];
  return setup;
}

export function describeSetup(s: Setup | undefined): string {
  if (!s || !Object.keys(s).length) return "";
  const main = [s.model, s.effort && `at ${s.effort}`].filter(Boolean).join(" ");
  const helpers = s.helperModel ? `with ${s.helperModel}${s.helperEffort ? ` (${s.helperEffort})` : ""} helpers` : "";
  return `Running ${[main, helpers].filter(Boolean).join(" ")}.`;
}

const safe = <T,>(f: () => T[]): T[] => {
  try {
    return f();
  } catch {
    return [];
  }
};

export class Tools {
  /** Numbers from the last get_updates, so "number 2" means what the user just heard. */
  private listing: string[] = [];
  private deps: ToolDeps;

  constructor(deps: ToolDeps) {
    this.deps = deps;
  }

  /** Desktop-app sessions plus sessions found only as transcripts (terminal, phone), newest first. */
  private desktop(window = { sinceMs: Date.now() - 48 * 3600_000, limit: 6 }): DesktopSession[] {
    if (this.deps.desktop) return safe(this.deps.desktop);
    const desk = safe(() => listDesktopSessions(window));
    const exclude = new Set<string>([
      ...safe(() => listDesktopSessions({ sinceMs: 0, limit: 100_000 })).map((d) => d.cliSessionId),
      ...this.deps.manager.sessions.flatMap((s) => (s.claudeSessionId ? [s.claudeSessionId] : [])),
    ]);
    const other = safe(() => listOtherSessions({ ...window, exclude }));
    return [...desk, ...other].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, window.limit);
  }

  private where(cwd: string): string {
    return folderLabel(cwd, gitAlias);
  }

  async run(name: string, args: Record<string, any>): Promise<Reply> {
    try {
      switch (name) {
        case "get_updates":
          return { text: this.updates() };
        case "check_attention":
          return {
            text: await scanAttention({
              sessions: this.deps.manager.sessions,
              // A wider look than get_updates: three days, up to 25 desktop sessions.
              desktop: this.desktop({ sinceMs: Date.now() - 72 * 3600_000, limit: 25 }),
              where: (cwd: string) => this.where(cwd),
              roots: this.deps.roots,
              repos: this.deps.repos,
            }),
          };
        case "get_session":
          return await this.getSession(String(args.session ?? ""), Number(args.wait_seconds) || 0);
        case "start_session":
          return this.start(args);
        case "new_project":
          return this.newProject(String(args.name ?? ""), String(args.task ?? ""), parseSetup(args));
        case "send_message":
          return this.send(String(args.session ?? ""), String(args.text ?? ""));
        case "answer_question":
          return this.answer(String(args.session ?? ""), args.decision, args.note);
        case "stop_session":
          return this.stop(String(args.session ?? ""));
        case "list_projects":
          return this.projects(args.query);
        default:
          return { text: `Unknown tool ${name}.`, isError: true };
      }
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
  }

  /** The overview the user hears; its numbers are what "number 2" means afterwards. */
  updates(): string {
    const { text, refs } = this.render();
    this.listing = refs;
    return text;
  }

  /** The same text for the offline snapshot, without changing the numbers the user heard last. */
  snapshot(): string {
    return this.render().text;
  }

  private render(): { text: string; refs: string[] } {
    const { manager } = this.deps;
    const recent = Date.now() - 12 * 3600_000;
    const bridge = [...manager.sessions].filter((s) => s.status === "working" || s.status === "needs_you" || s.updatedAt > recent);
    const needs = bridge.filter((s) => s.status === "needs_you");
    const working = bridge.filter((s) => s.status === "working");
    const finished = bridge.filter((s) => !needs.includes(s) && !working.includes(s)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
    const desk = this.desktop();

    const refs: string[] = [];
    const lines: string[] = [];
    const add = (ref: string, text: string) => {
      refs.push(ref);
      lines.push(`${refs.length}. ${text}`);
    };
    if (needs.length) lines.push("Needs you:");
    for (const s of needs) add(`b:${s.name}`, `${s.name} (${s.title}): wants to ${s.question?.about ?? "ask you something"}. Allow or deny?`);
    if (working.length) lines.push("Working:");
    for (const s of working) add(`b:${s.name}`, `${s.name} (${s.title}): working, started ${ago(s.createdAt)}${s.queue.length ? `, ${s.queue.length} message waiting` : ""}.`);
    if (finished.length) lines.push("Finished:");
    for (const s of finished) add(`b:${s.name}`, `${s.name} (${s.title}): ${STATUS[s.status]} ${ago(s.updatedAt)}. ${s.voice ?? ""}`.trim());
    if (desk.length) lines.push("Desktop and other sessions:");
    for (const d of desk) {
      const w = lastWords(transcriptPath(d.cwd, d.cliSessionId));
      add(`d:${d.id}`, `${kindLabel(d)} "${d.title}" in ${this.where(d.cwd)}, ${ago(d.lastActivityAt)}. ${w ? firstSentences(w.summary, 160) : ""}${w?.ask ? ` Needs from you: ${w.ask}` : ""}`.trim());
    }
    return { text: lines.length ? lines.join("\n") : "Nothing is running and nothing needs you.", refs };
  }

  /** True if the folder (after symlinks) is inside one of the project roots. */
  private inRoots(cwd: string): boolean {
    try {
      const real = realpathSync(cwd);
      return this.deps.roots.some((r) => {
        const root = realpathSync(r);
        return real.startsWith(root + sep);
      });
    } catch {
      return false;
    }
  }

  private resolve(query: string): Ref {
    const q = query.trim().toLowerCase().replace(/^(session|number|desktop)\s+/, "");
    if (!q) throw new Error("Which session? Say its name or number from the updates.");
    const desk = () => this.desktop();
    const fromRef = (ref: string | undefined): Ref | undefined => {
      if (!ref) return;
      if (ref.startsWith("b:")) {
        const rec = this.deps.manager.find(ref.slice(2));
        return rec && { kind: "bridge", rec };
      }
      const d = desk().find((x) => x.id === ref.slice(2));
      return d && { kind: "desktop", d };
    };
    if (/^\d+$/.test(q)) {
      if (!this.listing.length) this.updates();
      const r = fromRef(this.listing[Number(q) - 1]);
      if (r) return r;
      throw new Error(`There is no number ${q}. Ask for the updates first.`);
    }
    const exact = this.deps.manager.find(q);
    if (exact) return { kind: "bridge", rec: exact };

    const words = q.split(/\s+/).filter((w) => w.length > 2);
    const score = (text: string) => words.filter((w) => text.toLowerCase().includes(w)).length;
    const cands: { ref: Ref; s: number; at: number }[] = [
      ...this.deps.manager.sessions.map((rec) => ({ ref: { kind: "bridge", rec } as Ref, s: score(`${rec.name} ${rec.title} ${rec.project}`), at: rec.updatedAt })),
      ...desk().map((d) => ({ ref: { kind: "desktop", d } as Ref, s: score(`${d.title} ${this.where(d.cwd)}`), at: d.lastActivityAt })),
    ].filter((c) => c.s > 0);
    if (!cands.length) throw new Error(`I can't find a session called "${query}". Ask for the updates to hear the names.`);
    cands.sort((a, b) => b.s - a.s || b.at - a.at);
    return cands[0].ref;
  }

  private async getSession(query: string, waitSeconds: number): Promise<Reply> {
    const ref = this.resolve(query);
    if (ref.kind === "desktop") {
      const { d } = ref;
      const w = lastWords(transcriptPath(d.cwd, d.cliSessionId));
      return {
        text: [
          `${kindLabel(d)} "${d.title}" in ${this.where(d.cwd)}, last active ${ago(d.lastActivityAt)}.${d.source === "other" ? " It was started outside the desktop app, in a terminal or from the phone." : ""}`,
          w ? `Latest: ${w.summary}` : "I can't read its latest answer.",
          w?.ask ? `Needs from you: ${w.ask}` : "",
          "It is read-only here. To carry on, I can continue it in a new session.",
        ].filter(Boolean).join("\n"),
      };
    }
    const { rec } = ref;
    await this.deps.manager.waitFor(rec, Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) * 1000);
    const parts = [`${rec.name} (${rec.title}) in ${rec.project}: ${STATUS[rec.status]}, ${rec.status === "working" ? `started ${ago(rec.createdAt)}` : ago(rec.updatedAt)}.`];
    const how = describeSetup(rec.setup);
    if (how) parts.push(how);
    if (rec.status === "needs_you" && rec.question) parts.push(`It needs your permission to ${rec.question.about}. Allow or deny?`);
    if (rec.voice && rec.status !== "working") parts.push(rec.voice);
    if (rec.status === "working" && rec.voice) parts.push(`Last turn: ${rec.voice}`);
    if (rec.queue.length) parts.push(`${rec.queue.length} message waiting to run next.`);
    if (rec.result && rec.status !== "working") parts.push(`More detail: ${firstSentences(speakable(rec.result), 400)}`);
    return { text: parts.join("\n") };
  }

  private start(args: Record<string, any>): Reply {
    const task = String(args.task ?? "").trim();
    if (!task) return { text: "What should the session do?", isError: true };
    let project: string;
    let cwd: string;
    let forkFrom: string | undefined;

    if (args.continue_from) {
      const ref = this.resolve(String(args.continue_from));
      if (ref.kind === "desktop") {
        cwd = ref.d.cwd;
        project = basename(cwd);
        forkFrom = ref.d.cliSessionId;
      } else {
        if (!ref.rec.claudeSessionId) return { text: `${ref.rec.name} has no saved conversation yet. Send it a message instead.`, isError: true };
        cwd = ref.rec.cwd;
        project = ref.rec.project;
        forkFrom = ref.rec.claudeSessionId;
      }
    } else {
      const { project: p, options } = resolveProject(String(args.project ?? ""), this.deps.roots);
      if (!p) {
        if (options.length > 1) return { text: `Which project: ${options.join(", ")}?` };
        return { text: `I can't find a project called "${args.project ?? ""}". Ask me to list the projects.`, isError: true };
      }
      project = p.name;
      cwd = p.path;
    }
    if (!this.inRoots(cwd)) {
      return { text: `That session's folder is outside your projects folder, so I can't run it from here.`, isError: true };
    }
    const setup = parseSetup(args);
    const rec = this.deps.manager.start({ project, cwd, task, forkFrom, setup });
    const from = forkFrom ? " It starts with the old session's full context." : "";
    const how = describeSetup(rec.setup);
    return { text: `Started ${rec.name} in ${project}: ${rec.title}.${from}${how ? ` ${how}` : ""} It runs on your Mac; ask me for an update in a minute or two.` };
  }

  /** A new folder in the first projects root, with git, and a first session in it. */
  private newProject(name: string, task: string, setup: Setup): Reply {
    if (!task.trim()) return { text: "What should the new project start with?", isError: true };
    const folder = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (!folder) return { text: "What should the project be called?", isError: true };
    const path = join(this.deps.roots[0], folder);
    if (existsSync(path)) {
      return { text: `A project called ${folder} already exists. I can start a session in it instead.` };
    }
    mkdirSync(path);
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path, timeout: 5000 });
    } catch {
      // git is optional; the folder is enough to start
    }
    const rec = this.deps.manager.start({ project: folder, cwd: path, task, setup });
    const how = describeSetup(rec.setup);
    return { text: `Created the new project ${folder} and started ${rec.name}: ${rec.title}.${how ? ` ${how}` : ""} Ask me for an update in a few minutes.` };
  }

  private send(query: string, text: string): Reply {
    if (!text.trim()) return { text: "What should I send?", isError: true };
    const ref = this.resolve(query);
    if (ref.kind === "desktop") {
      return { text: `"${ref.d.title}" was not started by me, so I can't type into it. I can continue it in a new session with that message instead.` };
    }
    const how = this.deps.manager.send(ref.rec, text);
    return { text: how === "queued" ? `${ref.rec.name} is still working. Your message runs next.` : `Sent to ${ref.rec.name}. It is working on it.` };
  }

  private answer(query: string, decision: unknown, note: unknown): Reply {
    if (decision !== "allow" && decision !== "deny") return { text: "Say allow or deny.", isError: true };
    const ref = this.resolve(query);
    if (ref.kind === "desktop") return { text: "Answer that session where it runs (the desktop app or its terminal).", isError: true };
    const about = ref.rec.question?.about;
    if (!this.deps.manager.answer(ref.rec, decision, note ? String(note) : undefined)) {
      return { text: `${ref.rec.name} has no open question right now.` };
    }
    return { text: decision === "allow" ? `Allowed: ${about}. It carries on.` : `Denied. ${ref.rec.name} will find another way or stop.` };
  }

  private stop(query: string): Reply {
    const ref = this.resolve(query);
    if (ref.kind === "desktop") return { text: "Stop that session where it runs (the desktop app or its terminal).", isError: true };
    return { text: this.deps.manager.stop(ref.rec) ? `Stopping ${ref.rec.name}.` : `${ref.rec.name} was not working.` };
  }

  private projects(query: unknown): Reply {
    const q = String(query ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const flat = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
    const names = listProjects(this.deps.roots)
      .filter((p) => !q || flat(p.name).includes(q) || (p.alias && flat(p.alias).includes(q)))
      .map((p) => (p.alias ? `${p.name} (${p.alias})` : p.name))
      .sort();
    if (!names.length) return { text: q ? `No project matches "${query}".` : "No projects found." };
    return { text: `${names.length} projects: ${names.slice(0, 30).join(", ")}${names.length > 30 ? ", and more" : ""}.` };
  }
}

// One interactive `claude` process per bridge session, in a pseudo-terminal (agent/pty.py), with
// Remote Control on, so the session also shows in the Claude app and on claude.ai/code.
// Hooks (passed with --settings) append each event as one JSON line to a file we tail:
//   UserPromptSubmit → working · Notification (permission_prompt) → needs you · Stop → turn done.

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PTY = join(dirname(fileURLToPath(import.meta.url)), "pty.py");
// The installer puts claude in ~/.local/bin, which launchd's PATH does not have.
const CLAUDE = [join(homedir(), ".local/bin/claude")].find(existsSync) ?? "claude";

export interface CliEvent {
  hook_event_name: string;
  session_id?: string;
  last_assistant_message?: string;
  message?: string;
  notification_type?: string;
}

export interface CliArgs {
  name: string; // Remote Control name, e.g. "my-app-1: fix the login bug"
  sessionId: string;
  prompt: string;
  resume?: string; // an existing session to continue (ours, or a desktop one with fork)
  fork?: boolean;
  permissionMode: string;
  append: string;
  model?: string;
  effort?: string;
  agents?: Record<string, unknown>;
  eventsFile: string;
}

/** Whether Claude Code saved a transcript for this session id (only then can it be resumed). */
export function hasTranscript(sessionId: string, projectsDir = join(homedir(), ".claude/projects")): boolean {
  try {
    return readdirSync(projectsDir).some((d) => existsSync(join(projectsDir, d, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

/** The claude command line for a session. Pure, so tests can check it. */
export function cliArgs(a: CliArgs): string[] {
  const log = `cat >> '${a.eventsFile}'; echo >> '${a.eventsFile}'`;
  const hook = [{ hooks: [{ type: "command", command: log }] }];
  const settings = { hooks: { UserPromptSubmit: hook, Notification: hook, Stop: hook } };
  const args = ["--remote-control", a.name, "--permission-mode", a.permissionMode, "--settings", JSON.stringify(settings), "--append-system-prompt", a.append];
  if (a.resume) {
    args.push("--resume", a.resume);
    if (a.fork) args.push("--fork-session", "--session-id", a.sessionId);
  } else {
    args.push("--session-id", a.sessionId);
  }
  if (a.model) args.push("--model", a.model);
  if (a.effort) args.push("--effort", a.effort);
  if (a.agents) args.push("--agents", JSON.stringify(a.agents));
  if (a.prompt) args.push("--", a.prompt);
  return args;
}

export class CliProcess {
  private proc: ChildProcess;
  private offset = 0;
  private timer: NodeJS.Timeout;
  private screen = "";
  private prompted = false;
  exited = false;

  constructor(cwd: string, args: CliArgs, onEvent: (e: CliEvent) => void, onExit: (code: number | null) => void) {
    mkdirSync(dirname(args.eventsFile), { recursive: true });
    if (!existsSync(args.eventsFile)) writeFileSync(args.eventsFile, "");
    this.offset = statSync(args.eventsFile).size;

    // A session started from inside another Claude Code session would inherit its "child" marker
    // and stop saving its transcript; the bridge's sessions are top-level.
    // Same when the agent itself runs under a host app (its markers and API proxy must not leak in).
    const env: NodeJS.ProcessEnv = { ...process.env };
    const hosted = !!env.CLAUDE_CODE_HOST_SESSION_ID;
    for (const k of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_AGENT_SDK|_PID$|_EFFORT$|_PREVIEW)/.test(k)) delete env[k];
    if (hosted) delete env.ANTHROPIC_BASE_URL;
    env.TERM = "xterm-256color";

    this.proc = spawn("python3", ["-I", PTY, CLAUDE, ...cliArgs(args)], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const keep = (d: Buffer) => {
      this.screen = (this.screen + d.toString()).slice(-8000);
      // A folder Claude Code has not seen asks first; the list is "No, exit" (selected) then
      // "Yes, I trust this folder". Sessions only run inside the configured project roots: pick Yes.
      if (!this.prompted && /Yes,\s*I\s*trust\s*this\s*folder/i.test(this.screenText())) {
        this.prompted = true;
        // Wait until the dialog listens for keys (pressed too early, the choice is reset on redraw).
        setTimeout(() => this.key("\x1b[B"), 1500);
        setTimeout(() => this.key("\r"), 2300);
      }
    };
    this.proc.stdout!.on("data", keep);
    this.proc.stderr!.on("data", keep);
    this.proc.on("exit", (code) => {
      this.exited = true;
      if (code) console.log(new Date().toISOString(), `session ${args.name} exited ${code}; last screen:`, this.screenText().slice(-600));
      clearInterval(this.timer);
      this.poll(args.eventsFile, onEvent);
      onExit(code);
    });
    this.timer = setInterval(() => this.poll(args.eventsFile, onEvent), 400);
  }

  private poll(file: string, onEvent: (e: CliEvent) => void) {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= this.offset) return;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - this.offset);
    readSync(fd, buf, 0, buf.length, this.offset);
    closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return; // wait for a whole line
    this.offset += Buffer.byteLength(text.slice(0, end + 1));
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // a hook wrote something that is not one JSON line: skip it
      }
    }
  }

  /** The terminal's text without escape codes (for logs). */
  screenText(): string {
    return this.screen.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, "").replace(/\r/g, "\n").replace(/\n{2,}/g, "\n");
  }

  /** Type a message and press Enter (Enter goes separately, or the TUI takes it as a pasted newline). */
  type(text: string) {
    this.key(text.replace(/\r?\n/g, " "));
    setTimeout(() => this.key("\r"), 300);
  }

  key(k: string) {
    if (!this.exited) this.proc.stdin!.write(k);
  }

  kill() {
    if (!this.exited) this.proc.kill("SIGTERM");
  }
}

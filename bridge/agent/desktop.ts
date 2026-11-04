// Read-only view of Claude desktop app (Code tab) sessions: the app keeps one JSON file per
// session, and Claude Code keeps the transcript in ~/.claude/projects/<cwd>/<cliSessionId>.jsonl.
// We never write to either; to continue one, the bridge forks it (sessions.ts).

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findAsk, firstSentences } from "./text.ts";

export interface DesktopSession {
  id: string; // local_... (desktop app) or t_<uuid> (found only as a transcript)
  source?: "desktop" | "other"; // other = terminal, phone (Remote Control) or another tool
  cliSessionId: string;
  title: string;
  cwd: string;
  lastActivityAt: number;
}

export const DESKTOP_DIR = join(homedir(), "Library/Application Support/Claude/claude-code-sessions");

export function listDesktopSessions(opts: { dir?: string; sinceMs?: number; limit?: number } = {}): DesktopSession[] {
  const dir = opts.dir ?? DESKTOP_DIR;
  const since = opts.sinceMs ?? Date.now() - 48 * 3600_000;
  const out: DesktopSession[] = [];
  for (const account of safeDirs(dir)) {
    for (const org of safeDirs(join(dir, account))) {
      const orgDir = join(dir, account, org);
      for (const f of safeFiles(orgDir)) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(readFileSync(join(orgDir, f), "utf8"));
          if (d.isArchived || !d.cliSessionId || !d.cwd || (d.lastActivityAt ?? 0) < since) continue;
          out.push({ id: d.sessionId, source: "desktop", cliSessionId: d.cliSessionId, title: d.title || "Untitled", cwd: d.cwd, lastActivityAt: d.lastActivityAt });
        } catch {
          // a file being written right now: skip it this time
        }
      }
    }
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, opts.limit ?? 6);
}

export const PROJECTS_DIR = join(homedir(), ".claude/projects");

/**
 * Sessions the desktop app does not know: started in a terminal, from the phone (Remote Control) or by
 * another tool. Found from recently changed transcripts; the title is the start of the first prompt.
 */
export function listOtherSessions(opts: { dir?: string; sinceMs?: number; limit?: number; exclude?: Set<string> } = {}): DesktopSession[] {
  const dir = opts.dir ?? PROJECTS_DIR;
  const since = opts.sinceMs ?? Date.now() - 48 * 3600_000;
  const files: { path: string; id: string; mtime: number }[] = [];
  for (const project of safeDirs(dir)) {
    for (const f of safeFiles(join(dir, project))) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      if (opts.exclude?.has(id)) continue;
      try {
        const mtime = statSync(join(dir, project, f)).mtimeMs;
        if (mtime >= since) files.push({ path: join(dir, project, f), id, mtime });
      } catch {
        // removed while we looked
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: DesktopSession[] = [];
  for (const f of files) {
    if (out.length >= (opts.limit ?? 6)) break;
    const head = readHead(f.path);
    if (!head) continue;
    out.push({ id: `t_${f.id}`, source: "other", cliSessionId: f.id, title: head.title, cwd: head.cwd, lastActivityAt: f.mtime });
  }
  return out;
}

/** cwd and the first real prompt from the start of a transcript. */
function readHead(path: string): { cwd: string; title: string } | null {
  let cwd = "";
  for (const line of head(path, 200_000).split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isSidechain) return null;
    cwd ||= d.cwd ?? "";
    if (d.type !== "user" || !isRealPrompt(d.message?.content)) continue;
    const c = d.message.content;
    const text = typeof c === "string" ? c : c.find((b: any) => b.type === "text")?.text ?? "";
    // Our own bridge sessions start with the bridge's system prompt, not here; skip empty ones.
    return cwd ? { cwd, title: firstSentences(text, 60).replace(/[.…,;:]+$/, "") || "Untitled" } : null;
  }
  return null;
}

function head(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function transcriptPath(cwd: string, cliSessionId: string, projectsDir = join(homedir(), ".claude/projects")): string {
  return join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${cliSessionId}.jsonl`);
}

/** The latest turn's summary: the desktop app's wrap_up recap (and question) if there is one, else the last answer. */
export function lastWords(path: string): { summary: string; ask?: string } | null {
  if (!existsSync(path)) return null;
  const lines = tail(path, 600_000).split("\n");
  lines.shift(); // the first line is probably cut
  let lastText: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    let d: any;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = d?.message?.content;
    if (d.type === "user" && isRealPrompt(content)) break;
    if (d.type !== "assistant" || !Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b.type === "tool_use" && String(b.name).endsWith("wrap_up") && b.input?.recap) {
        return { summary: firstSentences(b.input.recap, 300), ask: b.input.ask ? firstSentences(b.input.ask, 120) : undefined };
      }
      if (b.type === "text" && b.text?.trim() && lastText === undefined) lastText = b.text;
    }
  }
  if (!lastText) return null;
  // Without a wrap_up (terminal or phone sessions), find the action item in the answer itself.
  const ask = findAsk(lastText);
  return ask ? { summary: firstSentences(lastText, 300), ask } : { summary: firstSentences(lastText, 300) };
}

function isRealPrompt(content: unknown): boolean {
  if (typeof content === "string") return !content.startsWith("<");
  return Array.isArray(content) && content.some((b: any) => b.type === "text" && !String(b.text).startsWith("<"));
}

function tail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function safeDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function safeFiles(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** How a session's folder is spoken: "my-app", "photo-accounts (photos)", "a scratch folder". */
export function folderLabel(cwd: string, alias?: (path: string) => string | undefined): string {
  if (cwd.includes("/scratch-workspaces/") || cwd.startsWith("/private/tmp") || cwd.startsWith("/tmp")) return "a scratch folder";
  const worktree = cwd.match(/^(.*?)\/\.claude-worktrees\//)?.[1] ?? cwd.match(/^(.*?)\/\.claude\/worktrees\//)?.[1];
  const base = worktree ?? cwd;
  const a = alias?.(base);
  return a ? `${basename(base)} (${a})` : basename(base);
}

/** "Desktop" for desktop-app sessions, "Session" for ones started elsewhere. */
export const kindLabel = (d: DesktopSession) => (d.source === "other" ? "Session" : "Desktop");

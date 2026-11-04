// "Is there anything I need to look into?" A quick scan (well under a second) of what may need the user:
// bridge sessions waiting or failed, desktop sessions whose last turn ended with a question,
// and projects with uncommitted or unpushed work.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { type DesktopSession, kindLabel, lastWords, transcriptPath } from "./desktop.ts";
import { listProjects } from "./projects.ts";
import type { SessionRecord } from "./sessions.ts";
import { ago, firstSentences } from "./text.ts";

const run = promisify(execFile);

export interface RepoState {
  name: string;
  changed: number; // files with uncommitted changes
  ahead: number; // commits not pushed
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout: 3000 });
  return stdout;
}

export async function repoStates(roots: string[]): Promise<RepoState[]> {
  const repos = listProjects(roots).filter((p) => existsSync(join(p.path, ".git")));
  const states = await Promise.all(
    repos.map(async (p): Promise<RepoState | null> => {
      try {
        const status = await git(p.path, ["status", "--porcelain"]);
        const changed = status.split("\n").filter(Boolean).length;
        // No upstream (a local-only branch) counts as nothing to push.
        const ahead = Number((await git(p.path, ["rev-list", "--count", "@{u}..HEAD"]).catch(() => "0")).trim()) || 0;
        return changed || ahead ? { name: p.name, changed, ahead } : null;
      } catch {
        return null;
      }
    }),
  );
  return states.filter((s): s is RepoState => !!s).sort((a, b) => b.changed + b.ahead * 3 - (a.changed + a.ahead * 3));
}

export async function scanAttention(p: {
  sessions: SessionRecord[];
  desktop: DesktopSession[];
  where?: (cwd: string) => string;
  roots: string[];
  repos?: (roots: string[]) => Promise<RepoState[]>;
}): Promise<string> {
  const items: string[] = [];
  const day = Date.now() - 24 * 3600_000;

  for (const s of p.sessions.filter((s) => s.status === "needs_you")) {
    items.push(`${s.name} is waiting for your permission to ${s.question?.about ?? "do something"}.`);
  }
  for (const s of p.sessions.filter((s) => s.status === "failed" && s.updatedAt > day)) {
    items.push(`${s.name} (${s.title}) failed ${ago(s.updatedAt)}. ${s.voice ?? ""}`.trim());
  }
  // A finished bridge session needs the user when its summary asks for something.
  const asks = (v = "") => !/nothing (?:is )?needed/i.test(v) && /\?|needs from you|need you|please|approve|decide|confirm|choose|your call/i.test(v);
  // A long summary keeps its asking sentence: that is why the session is listed, and it usually comes last.
  const brief = (v: string) => (v.length <= 160 ? v : firstSentences(v.split(/(?<=[.!?])\s+/).reverse().find((t) => asks(t)) ?? v, 160));
  for (const s of p.sessions.filter((s) => s.status === "done" && s.updatedAt > day && asks(s.voice))) {
    items.push(`${s.name} (${s.title}): ${brief(s.voice!)}`);
  }
  for (const d of p.desktop) {
    const w = lastWords(transcriptPath(d.cwd, d.cliSessionId));
    if (w?.ask) items.push(`${kindLabel(d)} "${d.title}" in ${(p.where ?? basename)(d.cwd)} needs from you: ${w.ask} (${ago(d.lastActivityAt)})`);
  }

  const repos = await (p.repos ?? repoStates)(p.roots).catch(() => []);
  const repoLines = repos.slice(0, 5).map((r) => {
    const parts = [r.changed ? `${r.changed} uncommitted file${r.changed > 1 ? "s" : ""}` : "", r.ahead ? `${r.ahead} unpushed commit${r.ahead > 1 ? "s" : ""}` : ""];
    return `${r.name}: ${parts.filter(Boolean).join(" and ")}.`;
  });

  if (!items.length && !repoLines.length) return "Nothing needs you. No session is waiting, and all projects are committed and pushed.";
  const out: string[] = [];
  if (items.length) out.push(`${items.length} thing${items.length > 1 ? "s" : ""} waiting for you:`, ...items.slice(0, 8).map((t, i) => `${i + 1}. ${t}`));
  else out.push("No session is waiting for you.");
  if (repoLines.length) out.push(`Projects with work not saved to git${repos.length > 5 ? ` (top 5 of ${repos.length})` : ""}:`, ...repoLines);
  return out.join("\n");
}

// Project folders a session may start in: folders directly under the configured roots
// (default ~/projects), or one level deeper as "parent/child". Nothing else, so a leaked
// connector URL cannot point a session at the whole disk.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Project {
  name: string; // "my-app" or "clients/shop"
  path: string;
  alias?: string; // the GitHub repo name when it differs, e.g. "photos" for photo-accounts
}

/** The repo name from .git/config's origin, lowercased, if it is not just the folder name. */
export function gitAlias(path: string): string | undefined {
  try {
    const cfg = readFileSync(join(path, ".git/config"), "utf8");
    const url = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
    const repo = url?.replace(/\.git$/, "").split(/[/:]/).pop()?.toLowerCase();
    const folder = path.split("/").pop()!.toLowerCase();
    return repo && norm(repo) !== norm(folder) ? repo : undefined;
  } catch {
    return undefined;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function dirs(path: string): string[] {
  try {
    return readdirSync(path).filter((n) => !n.startsWith(".") && n !== "node_modules" && isDir(join(path, n)));
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listProjects(roots: string[]): Project[] {
  return roots.flatMap((root) =>
    dirs(root).map((name) => {
      const path = join(root, name);
      const alias = gitAlias(path);
      return alias ? { name, path, alias } : { name, path };
    }),
  );
}

/** The project the user meant, or a list of close names to ask about. */
export function resolveProject(query: string, roots: string[]): { project?: Project; options: string[] } {
  const q = query.trim().replace(/^~\/projects\//, "");
  if (!q || q.includes("..") || q.startsWith("/") || q.startsWith("~")) return { options: [] };

  const [head, ...rest] = q.split("/");
  const all = listProjects(roots);
  const pick = (list: Project[], name: string): Project[] => {
    const n = norm(name);
    const exact = list.filter((p) => p.name.toLowerCase() === name.toLowerCase() || norm(p.name) === n || (p.alias && norm(p.alias) === n));
    if (exact.length) return exact;
    const starts = list.filter((p) => norm(p.name).startsWith(n));
    if (starts.length) return starts;
    return n.length >= 3 ? list.filter((p) => norm(p.name).includes(n)) : [];
  };

  const top = pick(all, head);
  if (top.length !== 1) return { options: top.map((p) => p.name).slice(0, 6) };
  if (!rest.length) return { project: top[0], options: [] };

  const children = dirs(top[0].path).map((name) => ({ name: `${top[0].name}/${name}`, path: join(top[0].path, name) }));
  const sub = pick(children.map((c) => ({ ...c, name: c.name.split("/")[1] })), rest.join("/")).map((c) => ({
    name: `${top[0].name}/${c.name}`,
    path: c.path,
  }));
  return sub.length === 1 ? { project: sub[0], options: [] } : { options: sub.map((p) => p.name).slice(0, 6) };
}

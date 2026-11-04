// Text, projects, desktop transcripts and the MCP handler: the pure parts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cliArgs } from "../agent/cli.ts";
import { lastWords, listOtherSessions } from "../agent/desktop.ts";
import { gitAlias, resolveProject } from "../agent/projects.ts";
import { extractVoice, findAsk, speakable } from "../agent/text.ts";
import { handleRpc, sameSecret } from "../worker/mcp.ts";

test("extractVoice takes the VOICE line out of the answer", () => {
  const r = extractVoice("Fixed the login bug in auth.ts.\n\nVOICE: I fixed the login bug. Please approve the deploy.");
  assert.equal(r.voice, "I fixed the login bug. Please approve the deploy.");
  assert.equal(r.body, "Fixed the login bug in auth.ts.");
  assert.equal(extractVoice("**VOICE:** Done. Nothing needed.").voice, "Done. Nothing needed.");
});

test("extractVoice falls back to the first sentences", () => {
  const r = extractVoice("All tests pass. I also cleaned up the imports and renamed two helpers so the names match.");
  assert.ok(r.voice.startsWith("All tests pass."));
  assert.ok(r.voice.length <= 221);
});

test("findAsk finds the action item in a plain answer", () => {
  const plan = "## Plan\n1. Add a stage view.\n\n## Decision for you\n\nDoes The client want one stage list for all shoots? I recommend all.\n\nTell me your choice and I will build it.";
  assert.equal(findAsk(plan), "Does The client want one stage list for all shoots?");
  assert.equal(findAsk("## Decisions I made\n1. Offline balance.\n\nAll done."), undefined); // Claude's own decisions are not for the user
  assert.equal(findAsk("Fixed it. Want me to deploy it now?"), "Want me to deploy it now?");
  assert.equal(findAsk("Fixed the bug. Tests pass."), undefined);
  const long = `Fixed the bug. ${"The cause was a stale cache in the loader. ".repeat(8)}\n\nShould I push it?`;
  assert.match(extractVoice(long).voice, /^Fixed the bug\..*Needs from you: Should I push it\?$/);
});

test("speakable drops code and long paths but keeps words like node_modules", () => {
  const s = speakable("Edited `/Users/me/projects/x/src/app.ts`.\n```js\nconst a = 1\n```\nSkipped node_modules. **Done**");
  assert.ok(!s.includes("const a"));
  assert.ok(!s.includes("/Users/me"));
  assert.ok(s.includes("node_modules"));
  assert.ok(s.includes("Done") && !s.includes("**"));
});

function projectsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vb-proj-"));
  for (const d of ["voice-bridge", "my-app", "my-app-backend", "clients/shop", ".hidden"]) mkdirSync(join(root, d), { recursive: true });
  return root;
}

test("resolveProject matches spoken names", () => {
  const root = projectsRoot();
  assert.equal(resolveProject("voice bridge", [root]).project?.name, "voice-bridge");
  assert.equal(resolveProject("My-app", [root]).project?.name, "my-app"); // exact beats the longer one
  assert.equal(resolveProject("clients/shop", [root]).project?.path, join(root, "clients/shop"));
});

test("resolveProject refuses paths outside the roots and asks when unsure", () => {
  const root = projectsRoot();
  assert.equal(resolveProject("../etc", [root]).project, undefined);
  assert.equal(resolveProject("/etc", [root]).project, undefined);
  assert.equal(resolveProject("~/secret", [root]).project, undefined);
  assert.deepEqual(resolveProject("my a", [root]).options.sort(), ["my-app", "my-app-backend"]);
});

test("lastWords prefers the desktop wrap_up recap of the latest turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-tr-"));
  const p = join(dir, "t.jsonl");
  const line = (o: unknown) => JSON.stringify(o);
  const lines = [
    "partial line that gets cut",
    line({ type: "user", message: { content: "old prompt" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__ccd_turn__wrap_up", input: { recap: "Old recap." } }] } }),
    line({ type: "user", message: { content: "new prompt" } }),
    line({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__ccd_turn__wrap_up", input: { recap: "Deploy is ready.", ask: "Ship it?" } }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Final words." }] } }),
  ];
  writeFileSync(p, lines.join("\n"));
  assert.deepEqual(lastWords(p), { summary: "Deploy is ready.", ask: "Ship it?" });
  writeFileSync(p, [lines[0], lines[3], lines[5]].join("\n"));
  assert.deepEqual(lastWords(p), { summary: "Final words." });
  // A terminal/phone session: no wrap_up, so a closing question counts as asking.
  writeFileSync(p, [lines[0], lines[3], line({ type: "assistant", message: { content: [{ type: "text", text: "Built it. Ship today?" }] } })].join("\n"));
  assert.equal(lastWords(p)?.ask, "Ship today?");

  // Sessions known only from transcripts, minus ones we already know (desktop or bridge).
  const projects = mkdtempSync(join(tmpdir(), "vb-pd-"));
  mkdirSync(join(projects, "-Users-me-projects-x"));
  const prompt = (cwd: string, text: string) => line({ type: "user", cwd, message: { content: text } });
  writeFileSync(join(projects, "-Users-me-projects-x", "aaa.jsonl"), prompt("/Users/me/projects/x", "The client wants a status page,"));
  writeFileSync(join(projects, "-Users-me-projects-x", "bbb.jsonl"), prompt("/Users/me/projects/x", "known one"));
  const other = listOtherSessions({ dir: projects, exclude: new Set(["bbb"]) });
  assert.deepEqual(other.map((o) => [o.id, o.title, o.cwd, o.source]), [["t_aaa", "The client wants a status page", "/Users/me/projects/x", "other"]]);

  // "Photos" is the repo name of the folder photo-accounts.
  const repo = join(projects, "photo-accounts");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git/config"), '[remote "origin"]\n\turl = git@github.com:someone/Photos.git\n');
  assert.equal(gitAlias(repo), "photos");
  assert.equal(resolveProject("Photos", [projects]).project?.name, "photo-accounts");
});

const noTools = async () => ({ text: "unused" });

test("CLI sessions start with Remote Control and resume or fork by session id", () => {
  const base = { name: "my-app-1: fix login", sessionId: "new-id", prompt: "Fix it", permissionMode: "auto", append: "VOICE", eventsFile: "/tmp/e.jsonl" };
  const fresh = cliArgs(base);
  assert.deepEqual(fresh.slice(0, 4), ["--remote-control", "my-app-1: fix login", "--permission-mode", "auto"]);
  assert.ok(fresh.includes("--session-id") && !fresh.includes("--resume"));
  assert.deepEqual(fresh.slice(-2), ["--", "Fix it"]);
  assert.ok(JSON.parse(fresh[fresh.indexOf("--settings") + 1]).hooks.Stop);
  const fork = cliArgs({ ...base, resume: "desktop-id", fork: true, model: "opus" });
  assert.deepEqual(fork.slice(fork.indexOf("--resume"), fork.indexOf("--resume") + 5), ["--resume", "desktop-id", "--fork-session", "--session-id", "new-id"]);
  assert.equal(fork[fork.indexOf("--model") + 1], "opus");
});

test("MCP initialize answers with a supported protocol version", async () => {
  const r: any = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }, noTools);
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.instructions.includes("voice"));
  const r2: any = await handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" } }, noTools);
  assert.equal(r2.result.protocolVersion, "2025-03-26");
});

test("MCP notifications get no reply, unknown methods an error, tools/list all tools", async () => {
  assert.equal(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, noTools), null);
  const bad: any = await handleRpc({ jsonrpc: "2.0", id: 3, method: "resources/list" }, noTools);
  assert.equal(bad.error.code, -32601);
  const list: any = await handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, noTools);
  assert.equal(list.result.tools.length, 9);
});

test("MCP tools/call forwards to the Mac and marks errors", async () => {
  const seen: unknown[] = [];
  const run = async (name: string, args: Record<string, unknown>) => {
    seen.push([name, args]);
    return name === "stop_session" ? { text: "nope", isError: true } : { text: "fine" };
  };
  const ok: any = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_updates", arguments: {} } }, run);
  assert.deepEqual(ok.result, { content: [{ type: "text", text: "fine" }] });
  const err: any = await handleRpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "stop_session", arguments: { session: "x" } } }, run);
  assert.equal(err.result.isError, true);
  const unknown: any = await handleRpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "rm_rf" } }, run);
  assert.equal(unknown.error.code, -32602);
  assert.equal(seen.length, 2);
  assert.ok(sameSecret("vb_abc", "vb_abc") && !sameSecret("vb_abc", "vb_abd") && !sameSecret("", ""));
});

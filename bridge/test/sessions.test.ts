// SessionManager and Tools with a fake `claude` process, so no real Claude runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliArgs, CliEvent } from "../agent/cli.ts";
import { SessionManager } from "../agent/sessions.ts";
import { Tools } from "../agent/tools.ts";

interface FakeProc {
  args: CliArgs;
  cwd: string;
  typed: string[];
  keys: string[];
  type(text: string): void;
  key(k: string): void;
  emit(e: CliEvent): void;
  exit(code: number | null): void;
}

function setup(opts: { transcripts?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vb-s-"));
  const roots = join(dir, "projects");
  mkdirSync(join(roots, "my-app"), { recursive: true });
  mkdirSync(join(roots, "my-app-backend"), { recursive: true });
  const procs: FakeProc[] = [];
  const statePath = join(dir, "state.json");
  const manager = new SessionManager(statePath, {
    permissionMode: "auto",
    hasTranscript: () => !!opts.transcripts,
    spawn: (cwd, args, onEvent, onExit) => {
      const p: FakeProc = {
        args,
        cwd,
        typed: [],
        keys: [],
        type(t) {
          this.typed.push(t);
        },
        key(k) {
          this.keys.push(k);
        },
        emit: onEvent,
        exit: onExit,
      };
      procs.push(p);
      return p;
    },
  });
  const tools = new Tools({ manager, roots: [roots], desktop: () => [] });
  return { manager, tools, procs, statePath, roots };
}

const stop = (text: string): CliEvent => ({ hook_event_name: "Stop", last_assistant_message: text });
const ask = (what: string): CliEvent => ({ hook_event_name: "Notification", notification_type: "permission_prompt", message: `Claude needs your permission to ${what}` });

test("a session runs, saves its voice summary and id, and survives a restart", async () => {
  const { manager, tools, procs, statePath } = setup();
  const start = await tools.run("start_session", { project: "my-app", task: "Add the pricing page. Keep it short." });
  assert.match(start.text, /^Started my-app-1 in my-app: Add the pricing page\./);
  const rec = manager.find("my-app-1")!;
  assert.equal(rec.status, "working");
  procs[0].emit(stop("Did it.\nVOICE: I added the page. Nothing needed."));
  assert.equal(rec.status, "done");
  assert.equal(rec.voice, "I added the page. Nothing needed.");
  assert.equal(rec.claudeSessionId, procs[0].args.sessionId);
  assert.equal(procs[0].args.permissionMode, "auto");
  assert.ok(procs[0].args.append.includes("VOICE:"));
  assert.equal(procs[0].args.model, undefined); // no choice → the usual model, no helpers
  assert.equal(procs[0].args.agents, undefined);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).sessions[0].name, "my-app-1");
  const again = new SessionManager(statePath, {});
  assert.equal(again.find("my-app-1")?.voice, "I added the page. Nothing needed.");

  // "Use Opus at high as orchestrator with Sonnet helpers", as voice Claude passes it.
  const orch = await tools.run("start_session", { project: "my-app", task: "Build the travel app", model: "Opus 5.5", effort: "high", helper_model: "sonnet" });
  assert.match(orch.text, /Running opus at high with sonnet helpers\./);
  const o = procs[1].args;
  assert.equal(o.model, "opus");
  assert.equal(o.effort, "high");
  assert.equal((o.agents as any).helper.model, "sonnet");
  assert.ok(o.append.includes("orchestrator"));
  const bad = await tools.run("start_session", { project: "my-app", task: "x", model: "gpt-9" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Say opus, sonnet, haiku or fable/);
});

test("a permission request waits for the user; allow presses 1, deny presses Esc and sends the note", async () => {
  const { manager, tools, procs } = setup();
  await tools.run("start_session", { project: "my-app", task: "Deploy it" });
  const rec = manager.find("my-app-1")!;
  procs[0].emit(ask("use Bash"));
  assert.equal(rec.status, "needs_you");
  assert.match((await tools.run("get_updates", {})).text, /Needs you:\n1\. my-app-1 \(Deploy it\): wants to use Bash\. Allow or deny\?/);
  tools.snapshot(); // must not change what "1" means
  const ans = await tools.run("answer_question", { session: "1", decision: "allow" });
  assert.match(ans.text, /^Allowed: use Bash/);
  assert.deepEqual(procs[0].keys, ["1"]);
  assert.equal(rec.status, "working");

  procs[0].emit(ask("use Bash"));
  await tools.run("answer_question", { session: "my-app-1", decision: "deny", note: "not today" });
  assert.equal(procs[0].keys[1], "\x1b");
  await new Promise((r) => setTimeout(r, 850));
  assert.deepEqual(procs[0].typed, ["not today"]);
  procs[0].emit(stop("VOICE: Skipped the deploy."));
  assert.equal(rec.voice, "Skipped the deploy.");
  assert.match((await tools.run("answer_question", { session: "my-app-1", decision: "allow" })).text, /no open question/);
});

test("a message sent while working runs next; a closed session resumes by id", async () => {
  const { manager, tools, procs } = setup({ transcripts: true });
  await tools.run("start_session", { project: "my-app", task: "First" });
  const rec = manager.find("my-app-1")!;
  const sent = await tools.run("send_message", { session: "my-app-1", text: "Second" });
  assert.match(sent.text, /still working\. Your message runs next/);
  assert.deepEqual(procs[0].typed, []);
  procs[0].emit(stop("VOICE: Turn 1 done."));
  assert.deepEqual(procs[0].typed, ["Second"]);
  assert.equal(rec.status, "working");

  procs[0].exit(1);
  assert.equal(rec.status, "failed");
  await tools.run("send_message", { session: "my-app-1", text: "Third" });
  assert.equal(procs.length, 2);
  assert.equal(procs[1].args.resume, rec.claudeSessionId);
  assert.equal(procs[1].args.fork, false);
  assert.equal(procs[1].args.prompt, "Third");
});

test("tools ask instead of guessing, and continuing a desktop session forks it", async () => {
  const { tools, procs, roots, manager } = setup();
  const which = await tools.run("start_session", { project: "my", task: "x" });
  assert.equal(which.text, "Which project: my-app, my-app-backend?");
  const none = await tools.run("get_session", { session: "nothing like this" });
  assert.equal(none.isError, true);

  const desk = new Tools({
    manager,
    roots: [roots],
    desktop: () => [{ id: "local_1", cliSessionId: "cli-123", title: "Free sites live count", cwd: join(roots, "my-app"), lastActivityAt: Date.now() }],
  });
  const started = await desk.run("start_session", { continue_from: "free sites", task: "Carry on" });
  assert.match(started.text, /full context/);
  assert.equal(procs[0].args.resume, "cli-123");
  assert.equal(procs[0].args.fork, true);
  const toDesktop = await desk.run("send_message", { session: "free sites", text: "hi" });
  assert.match(toDesktop.text, /not started by me/);
  procs[0].emit(stop("VOICE: Picked up where it left off."));

  // "Anything I need to look into?": a real git repo with an uncommitted file, and nothing waiting.
  const repo = join(roots, "my-app");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "notes.txt"), "draft");
  const created = await tools.run("new_project", { name: "Wedding Budget App!", task: "Set up a Vite app" });
  assert.match(created.text, /^Created the new project wedding-budget-app and started wedding-budget-app-1/);
  assert.ok(existsSync(join(roots, "wedding-budget-app", ".git")));
  assert.match((await tools.run("new_project", { name: "my-app", task: "x" })).text, /already exists/);
  await tools.run("new_project", { name: "../../etc", task: "x" }); // becomes the folder "etc" inside the root
  assert.ok(existsSync(join(roots, "etc")));
  for (const p of procs.slice(1)) p.emit(stop("VOICE: Set up. Nothing needed."));
  execFileSync("rm", ["-rf", join(roots, "wedding-budget-app"), join(roots, "etc")]);
  const scan = await tools.run("check_attention", {});
  assert.match(scan.text, /No session is waiting for you\.\nProjects with work not saved to git:\nmy-app: 1 uncommitted file\./);
});

test("check_attention keeps the ask of a long summary, and get_session waits at most 12 s", async () => {
  const { manager, tools, procs } = setup();
  await tools.run("start_session", { project: "my-app", task: "Check the icons" });
  procs[0].emit(stop("VOICE: I checked all apps on both phones, added 14 public icons, switched 9 to real brand logos, and made 21 private icons for your own apps. Nothing is built or uploaded. Please check the unnamed app on the tablet."));
  assert.match((await tools.run("check_attention", {})).text, /my-app-1 \(Check the icons\): Please check the unnamed app on the tablet\./);

  let waited = -1;
  manager.waitFor = async (_rec, ms) => {
    waited = ms;
  };
  await tools.run("get_session", { session: "my-app-1", wait_seconds: 20 });
  assert.equal(waited, 12_000);
});

test("stop presses Esc, the session limit holds, and outside folders are refused", async () => {
  const { manager, tools, roots, procs } = setup();
  await tools.run("start_session", { project: "my-app", task: "Ship" });
  const rec = manager.find("my-app-1")!;
  await tools.run("stop_session", { session: "my-app-1" });
  assert.deepEqual(procs[0].keys, ["\x1b"]);
  assert.equal(rec.status, "stopped");
  procs[0].emit(stop("VOICE: late")); // the Stop hook after the interrupt does not undo "stopped"
  assert.equal(rec.status, "stopped");

  for (const t of ["a", "b", "c", "d"]) await tools.run("start_session", { project: "my-app", task: t });
  const full = await tools.run("start_session", { project: "my-app", task: "e" });
  assert.equal(full.isError, true);
  assert.match(full.text, /already working/);
  for (const p of procs) p.emit(stop("VOICE: Done."));

  const outside = new Tools({
    manager,
    roots: [roots],
    desktop: () => [{ id: "local_9", cliSessionId: "cli-9", title: "Home folder chat", cwd: tmpdir(), lastActivityAt: Date.now() }],
  });
  const refused = await outside.run("start_session", { continue_from: "home folder", task: "x" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /outside your projects folder/);
});

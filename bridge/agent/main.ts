// The Mac agent: keeps one outbound WebSocket to the Worker hub, runs tool calls, and pushes a
// snapshot of get_updates whenever something changes (the hub shows it while the Mac is offline).
// Run: node agent/main.ts   (launchd keeps it running; see scripts/setup.sh)

import { hostname } from "node:os";
import WebSocket from "ws";
import type { AgentToHub, HubToAgent } from "../shared/tools.ts";
import { loadConfig } from "./config.ts";
import { SessionManager } from "./sessions.ts";
import { Tools } from "./tools.ts";

const VERSION = "1.0.0";
const cfg = loadConfig();
const manager = new SessionManager(cfg.statePath, {
  permissionMode: cfg.permissionMode,
  model: cfg.model,
  maxWorking: cfg.maxWorking,
});
const tools = new Tools({ manager, roots: cfg.projectRoots });

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

let ws: WebSocket | undefined;
let backoff = 1000;
let lastPong = Date.now();

function send(msg: AgentToHub) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

let snapTimer: NodeJS.Timeout | undefined;
function pushSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => send({ type: "snapshot", text: tools.snapshot(), at: Date.now() }), 1000);
}
manager.on("change", pushSnapshot);

function connect() {
  const url = cfg.hubUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/agent";
  // A connection attempt can hang: give up after 8 s and retry, or the Mac looks offline until the
  // system's own timeout (about 40 s).
  ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.agentToken}` }, handshakeTimeout: 8000 });

  ws.on("open", () => {
    log("connected", url);
    backoff = 1000;
    lastPong = Date.now();
    send({ type: "hello", version: VERSION, host: hostname() });
    pushSnapshot();
  });

  ws.on("message", async (raw) => {
    const text = raw.toString();
    if (text === "pong") {
      lastPong = Date.now();
      return;
    }
    let msg: HubToAgent;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type !== "call") return;
    const t0 = Date.now();
    const reply = await tools.run(msg.tool, msg.args ?? {});
    log("tool", msg.tool, JSON.stringify(msg.args ?? {}).slice(0, 200), `${Date.now() - t0}ms`, reply.isError ? "ERROR" : "ok");
    send({ type: "result", id: msg.id, text: reply.text, isError: reply.isError });
  });

  ws.on("close", (code) => {
    log("closed", code, `retry in ${backoff}ms`);
    ws = undefined;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });

  ws.on("error", (e) => log("ws error", e.message));
}

// Keep-alive: the hub answers "ping" with "pong" without waking up. No pong for 75 s → reconnect
// (after sleep or a network change the old socket can hang without closing).
setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastPong > 75_000) {
    log("no pong, reconnecting");
    ws.terminate();
    return;
  }
  ws.send("ping");
}, 25_000);

process.on("SIGTERM", () => process.exit(0));
log(`voice-bridge agent ${VERSION}, roots: ${cfg.projectRoots.join(", ")}, mode: ${cfg.permissionMode}`);
connect();

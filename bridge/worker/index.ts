// Cloudflare Worker on your own Cloudflare account.
//   POST /mcp/<MCP_TOKEN>   MCP endpoint for the Claude app (token in the path, no sign-in)
//   GET  /agent             WebSocket from the Mac agent (Authorization: Bearer <AGENT_TOKEN>)
//   GET  /health            "ok" plus whether the Mac is online
// One Durable Object ("hub") holds the Mac's WebSocket and forwards each tool call to it.

import { DurableObject } from "cloudflare:workers";
import { handleMcpHttp, json, sameSecret } from "./mcp.ts";
import { type AgentToHub, type HubToAgent, MAX_WAIT_SECONDS } from "../shared/tools.ts";

interface Env {
  HUB: DurableObjectNamespace<Hub>;
  MCP_TOKEN: string;
  AGENT_TOKEN: string;
}

// claude.ai drops a voice-mode tool call after about 30 s, so the Mac must answer well before that.
const CALL_TIMEOUT_MS = 15_000;
const WAIT_TOOL_EXTRA_MS = 5_000;
const HARD_TIMEOUT_MS = 28_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const hub = env.HUB.get(env.HUB.idFromName("hub"));

    if (url.pathname === "/health") {
      const status = await hub.status();
      return json({ ok: true, mac: status.online ? "online" : "offline", lastSeen: status.lastSeen });
    }

    if (url.pathname === "/agent") {
      const auth = req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
      if (!sameSecret(auth, env.AGENT_TOKEN)) return new Response("unauthorized", { status: 401 });
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      return hub.fetch(req);
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "mcp") {
      const token = parts[1] ?? req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
      if (!sameSecret(token, env.MCP_TOKEN)) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid token." } }, 401);
      }
      return handleMcpHttp(req, async (name, args) => {
        const t0 = Date.now();
        // Always answer before claude.ai gives up (about 30 s in voice mode), even if the hub stalls.
        const late = new Promise<{ text: string; isError: boolean }>((resolve) =>
          setTimeout(() => resolve({ text: "The Mac did not answer in time. Check with get_updates before trying again.", isError: true }), HARD_TIMEOUT_MS),
        );
        const r = await Promise.race([hub.callTool(name, args), late]);
        console.log(JSON.stringify({ tool: name, ms: Date.now() - t0, error: !!r.isError }));
        return r;
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

export class Hub extends DurableObject<Env> {
  private pending = new Map<string, (r: { text: string; isError?: boolean }) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answers the agent's keep-alive without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The newest open Mac socket. A replaced one can linger in CLOSING after the Mac wakes from sleep. */
  private agent(): WebSocket | undefined {
    return this.ctx.getWebSockets("agent").filter((ws) => ws.readyState === WebSocket.OPEN).pop();
  }

  async fetch(_req: Request): Promise<Response> {
    // A new Mac connection replaces the old one.
    for (const old of this.ctx.getWebSockets("agent")) old.close(1012, "replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["agent"]);
    await this.ctx.storage.put("lastSeen", Date.now());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async status(): Promise<{ online: boolean; lastSeen: number | null }> {
    return { online: !!this.agent(), lastSeen: (await this.ctx.storage.get<number>("lastSeen")) ?? null };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const ws = this.agent();
    if (!ws) return this.offline(name);
    const id = crypto.randomUUID();
    const wait = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_WAIT_SECONDS) * 1000;
    const timeoutMs = wait ? wait + WAIT_TOOL_EXTRA_MS : CALL_TIMEOUT_MS;
    const result = new Promise<{ text: string; isError?: boolean }>((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ text: "The Mac did not answer in time. The request may still have gone through: check with get_updates before trying again.", isError: true });
        }
      }, timeoutMs);
    });
    try {
      ws.send(JSON.stringify({ type: "call", id, tool: name, args } satisfies HubToAgent));
    } catch {
      this.pending.delete(id);
      return this.offline(name);
    }
    return result;
  }

  private async offline(name: string): Promise<{ text: string; isError?: boolean }> {
    const snap = await this.ctx.storage.get<{ text: string; at: number }>("snapshot");
    const head = "The user's Mac is offline right now (asleep or no internet), so I can't reach Claude Code.";
    if (name === "get_updates" && snap) {
      const mins = Math.round((Date.now() - snap.at) / 60000);
      return { text: `${head} Last known state, from ${mins} min ago:\n${snap.text}` };
    }
    return { text: head, isError: true };
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: AgentToHub;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (msg.type === "result") {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve({ text: msg.text, isError: msg.isError });
      }
    } else if (msg.type === "snapshot") {
      await this.ctx.storage.put("snapshot", { text: msg.text, at: msg.at });
      await this.ctx.storage.put("lastSeen", Date.now());
    } else if (msg.type === "hello") {
      await this.ctx.storage.put("lastSeen", Date.now());
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "closed");
    } catch {
      // already closed
    }
  }
}

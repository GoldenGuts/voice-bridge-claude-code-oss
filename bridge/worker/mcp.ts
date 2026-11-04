// MCP over Streamable HTTP: stateless, JSON replies only (no SSE),
// which works in Claude voice mode on Android. Pure: the tool runner is passed in, so tests run in Node.

import { INSTRUCTIONS, TOOL_NAMES, TOOLS } from "../shared/tools.ts";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

export async function handleRpc(m: RpcMessage, runTool: ToolRunner): Promise<unknown | null> {
  if (!m || typeof m !== "object" || !m.method) return null; // a response or junk: nothing to answer
  const isNotification = m.id === undefined || m.id === null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });

  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "voice-bridge", title: "Claude Code (voice bridge)", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return isNotification ? null : ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      if (!TOOL_NAMES.has(name)) return fail(-32602, `Unknown tool: ${name}`);
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const { text, isError } = await runTool(name, args);
        return ok({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Something went wrong: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return isNotification ? null : fail(-32601, `Method not found: ${m.method}`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

/** One HTTP request to the MCP endpoint, after the token check. */
export async function handleMcpHttp(req: Request, runTool: ToolRunner): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") {
    return new Response("voice-bridge MCP server: send JSON-RPC with POST.", { status: 405, headers: { ...CORS, Allow: "POST" } });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => handleRpc(m as RpcMessage, runTool)))).filter((r) => r !== null);
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? replies : replies[0]);
}

/** Constant-time string compare, so the token check does not leak timing. */
export function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

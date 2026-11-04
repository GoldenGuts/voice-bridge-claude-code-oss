// Claude Code sessions open right now on this Mac (terminal or desktop app), and how to message one.
// Each running session lists itself in ~/.claude/sessions/<pid>.json with a Unix socket for messages
// from other sessions. The session shows such a message as coming from another session, and its own
// permission rules still apply. Claude Code does not document this interface, so an update can break it.
// talk-to-claude-code (MIT, https://github.com/osaighi/talk-to-claude-code) worked out the protocol.

import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenSession {
  pid: number;
  sessionId: string;
  socket: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isSocket = (path: string) => {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
};

export function listOpenSessions(dir = join(homedir(), ".claude/sessions")): OpenSession[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const open: OpenSession[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      // An entry outlives a killed process, and sessions older than Claude Code 2.1.229 have no socket.
      if (typeof r.sessionId === "string" && alive(r.pid) && isSocket(r.messagingSocketPath)) {
        open.push({ pid: r.pid, sessionId: r.sessionId, socket: r.messagingSocketPath });
      }
    } catch {
      // being rewritten by its session, or not one of ours: skip it
    }
  }
  return open;
}

/** Puts a message in the session's queue. It runs now if the session is idle, or next if it is busy. */
export function messageOpenSession(s: OpenSession, text: string, timeoutMs = 5000): Promise<void> {
  const frame = { type: "user", message: { role: "user", content: text }, msg_id: randomBytes(16).toString("hex") };
  return new Promise((resolve, reject) => {
    const socket = connect({ path: s.socket });
    const timer = setTimeout(() => socket.destroy(new Error("timed out")), timeoutMs);
    socket.on("connect", () => socket.end(`${JSON.stringify(frame)}\n`));
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

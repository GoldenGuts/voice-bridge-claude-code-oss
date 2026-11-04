// Agent config: ~/.voice-bridge/config.json (written by scripts/setup.sh, mode 600).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_DIR = process.env.VOICE_BRIDGE_HOME || join(homedir(), ".voice-bridge");

export interface Config {
  hubUrl: string; // https://voice-bridge-claude-code.<you>.workers.dev
  agentToken: string;
  projectRoots: string[];
  permissionMode: string; // a claude --permission-mode value: "auto", "default", ...
  model?: string;
  maxWorking: number;
  statePath: string;
}

export function loadConfig(path = join(HOME_DIR, "config.json")): Config {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw.hubUrl || !raw.agentToken) throw new Error(`${path} needs hubUrl and agentToken`);
  if (raw.permissionMode === "bypassPermissions") throw new Error("bypassPermissions is not allowed: the connector URL can start sessions");
  return {
    hubUrl: raw.hubUrl,
    agentToken: raw.agentToken,
    projectRoots: (raw.projectRoots ?? ["~/projects"]).map((p: string) => p.replace(/^~/, homedir())),
    permissionMode: raw.permissionMode ?? "auto",
    model: raw.model,
    maxWorking: raw.maxWorking ?? 4,
    statePath: raw.statePath ?? join(HOME_DIR, "state.json"),
  };
}

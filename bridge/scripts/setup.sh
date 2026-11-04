#!/usr/bin/env bash
# One-time setup on your Mac (safe to run again):
#   1. makes two secrets (kept in ~/.voice-bridge, mode 600; reused on later runs)
#   2. deploys the Worker to your own Cloudflare account and sets its secrets
#   3. writes ~/.voice-bridge/config.json and installs a launchd agent (starts at login, restarts if it dies)
# The connector URL for the Claude app goes to ~/.voice-bridge/connector-url.txt. Treat it like a password.
#
#   scripts/setup.sh                       everything
#   scripts/setup.sh --projects ~/code     set the folder that holds your projects (default: ~/projects)
#   scripts/setup.sh --agent               only (re)install the launchd agent
#   scripts/setup.sh --rotate              new connector URL (the old one stops working)
#   scripts/setup.sh --uninstall           remove the launchd agent and delete the Worker
#   scripts/setup.sh --no-agent            deploy only; run the agent yourself with `npm run agent`
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${VOICE_BRIDGE_HOME:-$HOME/.voice-bridge}"
LABEL="io.github.voice-bridge-claude-code"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROTATE="" PROJECTS="" AGENT=1 MODE=all

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) MODE=agent ;;
    --uninstall) MODE=uninstall ;;
    --rotate) ROTATE=1 ;;
    --no-agent) AGENT=0 ;;
    --projects) PROJECTS="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

secret() { printf '%s_%s' "$1" "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"; }
read_or_make() { # file prefix force
  if [ ! -s "$1" ] || [ -n "${3:-}" ]; then (umask 077; secret "$2" > "$1"); fi
  cat "$1"
}

stop_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
}

install_agent() {
  local node; node="$(command -v node)"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$node</string><string>$ROOT/agent/main.ts</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/agent.log</string>
</dict></plist>
PLIST_EOF
  stop_agent
  # bootout returns before the old job is gone; bootstrap right after fails with an I/O error.
  local ok=""
  for _ in 1 2 3 4 5; do sleep 1; launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && { ok=1; break; }; done
  [ -n "$ok" ] || { echo "Could not start the launchd agent. Check: launchctl print gui/$(id -u)/$LABEL" >&2; exit 1; }
  echo "Agent installed. Log: $HOME_DIR/agent.log"
}

mkdir -p "$HOME_DIR" && chmod 700 "$HOME_DIR"
cd "$ROOT"

if [ "$MODE" = agent ]; then install_agent; exit 0; fi
if [ "$MODE" = uninstall ]; then
  stop_agent; rm -f "$PLIST"
  npx wrangler delete --force
  echo "Removed the agent and the Worker. Your settings are still in $HOME_DIR."
  exit 0
fi

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || { echo "This needs Node 22.18 or newer. You have $(node -v)." >&2; exit 1; }
[ -x "$HOME/.local/bin/claude" ] || command -v claude >/dev/null \
  || { echo "Claude Code is not installed. See https://claude.com/claude-code" >&2; exit 1; }
[ -d node_modules ] || npm ci
npx wrangler whoami 2>/dev/null | grep -qi 'associated with the email\|logged in' || npx wrangler login

MCP_TOKEN="$(read_or_make "$HOME_DIR/mcp-token" vb "$ROTATE")"
AGENT_TOKEN="$(read_or_make "$HOME_DIR/agent-token" vba)"

# tee, so a first-time question from Cloudflare (your workers.dev name) stays visible and can be answered.
npx wrangler deploy 2>&1 | tee "$HOME_DIR/deploy.log"
HUB_URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$HOME_DIR/deploy.log" | head -1)"
[ -n "$HUB_URL" ] || { echo "Could not find the workers.dev URL in the output above." >&2; exit 1; }
printf '%s' "$MCP_TOKEN" | npx wrangler secret put MCP_TOKEN >/dev/null
printf '%s' "$AGENT_TOKEN" | npx wrangler secret put AGENT_TOKEN >/dev/null

(umask 077
  python3 -I - "$HOME_DIR/config.json" "$HUB_URL" "$AGENT_TOKEN" "$PROJECTS" <<'PY'
import json, os, sys
path, hub, token, projects = sys.argv[1:5]
cfg = json.load(open(path)) if os.path.exists(path) else {}
cfg.update({"hubUrl": hub, "agentToken": token})
if projects:
    cfg["projectRoots"] = [projects]
cfg.setdefault("projectRoots", ["~/projects"])
cfg.setdefault("permissionMode", "auto")
cfg.setdefault("maxWorking", 4)
json.dump(cfg, open(path, "w"), indent=2)
PY
  printf '%s/mcp/%s\n' "$HUB_URL" "$MCP_TOKEN" > "$HOME_DIR/connector-url.txt")

[ "$AGENT" = 1 ] && install_agent
echo
echo "Done. Show the connector URL with: cat $HOME_DIR/connector-url.txt"
echo "Treat it like a password: anyone with it can start Claude Code sessions on this Mac."

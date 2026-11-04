#!/usr/bin/env bash
# Call the live connector the way the Claude app does, and print the text reply.
#   scripts/mcp.sh list                         tools/list (names only)
#   scripts/mcp.sh get_updates
#   scripts/mcp.sh start_session '{"project":"my-app","task":"..."}'
# Uses connector-url.txt in ~/.voice-bridge (or $VOICE_BRIDGE_HOME).
set -euo pipefail
URL="$(cat "${VOICE_BRIDGE_HOME:-$HOME/.voice-bridge}/connector-url.txt")"
call() {
  local out
  for _ in 1 2 3; do
    out="$(curl -s --connect-timeout 5 -m 40 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "$URL" -d "$1")" && [ -n "$out" ] && { printf '%s' "$out"; return; }
  done
  echo '{"jsonrpc":"2.0","id":1,"error":{"code":0,"message":"no answer from the connector (network?)"}}'
}
if [ "${1:-list}" = "list" ]; then
  call '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -I -c 'import sys,json; print(" ".join(t["name"] for t in json.load(sys.stdin)["result"]["tools"]))'
  exit
fi
ARGS="${2:-}"
[ -n "$ARGS" ] || ARGS='{}'
call "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$ARGS}}" |
  python3 -I -c 'import sys,json; r=json.load(sys.stdin); res=r.get("result") or {}; print(("ERROR: " if res.get("isError") or "error" in r else "") + (res.get("content",[{}])[0].get("text") if res else json.dumps(r["error"])))'

# The bridge

```
Claude app (voice) ──► claude.ai ──► Cloudflare Worker ──► Durable Object "hub"
                                                               ▲ one outbound WebSocket
                                                               │
                                              Mac agent (launchd) ──► claude --remote-control ...
```

- **`worker/`**: the MCP endpoint at `/mcp/<token>`, stateless JSON-RPC. The Durable Object holds the Mac's WebSocket and forwards
  each tool call. No inbound port opens on your Mac.
- **`agent/`**: runs on the Mac. Each session is an interactive `claude --remote-control` process in a pseudo-terminal, so it also
  shows in the Claude app and on claude.ai/code. Hooks report when a session works, needs you, or stops. It uses the normal `claude` program with your own sign-in.
- **`shared/tools.ts`**: the tool list and the instructions for voice Claude.

## Tools

| Tool | What it does |
| --- | --- |
| `get_updates` | Overview of all sessions: which need you, which are working, what finished |
| `check_attention` | Quick scan: open questions, failed sessions, sessions that ended with a question, projects with unsaved git work |
| `get_session` | One session: what it did and what it needs from you. Can wait up to 12 s |
| `start_session` | A new session in a project, or `continue_from` an older session. Optional `model`, `effort`, `helper_model`, `helper_effort` |
| `new_project` | Creates a folder with git, and starts a session there |
| `send_message` | A follow-up. It runs next if the session is busy |
| `answer_question` | Allow or deny a permission question |
| `stop_session` | Stops the current work |
| `list_projects` | The project folders |

Voice mode drops a tool call after about 30 s, so every tool answers fast and the work runs in the background.

## Config

`~/.voice-bridge/config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `projectRoots` | `["~/projects"]` | Folders that hold your projects. A session can start one level or two levels down |
| `permissionMode` | `auto` | A `claude --permission-mode` value. `bypassPermissions` is refused |
| `model` | your default | Model when you do not name one |
| `maxWorking` | `4` | Sessions that can work at the same time |

After a change, restart the agent:

```bash
launchctl kickstart -k gui/$(id -u)/io.github.voice-bridge-claude-code
```

## Commands

```bash
scripts/setup.sh --agent       # reinstall the background agent
scripts/setup.sh --rotate      # make a new connector URL
scripts/setup.sh --uninstall   # remove the agent and the Worker
scripts/mcp.sh list            # call your connector from the terminal
scripts/mcp.sh get_updates
npm test
```

## Troubleshooting

- **Voice Claude says the Mac is offline.** Open `https://<your-worker>.workers.dev/health`. See `~/.voice-bridge/agent.log`. A Mac that sleeps goes offline.
- **A session fails at once.** The log shows the last screen of the session. If your plan has no auto mode, set `permissionMode` to `default`.
- **A session does not show on your phone.** Remote Control needs Claude Code signed in with a claude.ai account, not an API key.

## Limits

- macOS only. The agent uses launchd, and it reads the Claude desktop app's session files.
- A restart of the agent ends running sessions. Send a message to resume one.
- Session processes stay open after they finish, so that Remote Control stays available. Each one uses memory until the agent restarts.

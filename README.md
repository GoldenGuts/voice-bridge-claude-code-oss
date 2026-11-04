# Voice Bridge for Claude Code

Talk to your Claude Code sessions from your phone, with earphones in.

Press a button on your earphones. Claude's voice mode opens. Ask "anything I need to look into?" or
"start a session in my-app and add a pricing page". The work runs on your Mac, and you hear what was
done and what is needed from you, in plain words.

It has two parts. You can use either one alone.

| Part | What it does | Runs on |
| --- | --- | --- |
| [`bridge/`](bridge/) | A connector for the Claude app, so voice mode can start, check and answer Claude Code sessions | Your Mac and your own free Cloudflare account |
| [`android/`](android/) | Voice Trigger: one press on any earphones opens Claude (or Gemini) voice, without changing your default assistant | Your Android phone |

```
Earphone button ──► Voice Trigger ──► Claude voice mode ──► claude.ai
                                                               │ custom connector
                                                               ▼
                 your Mac  ◄── WebSocket ── Cloudflare Worker (your account)
                    │
                    └─ real `claude --remote-control` sessions, also visible in the Claude app
```

This project is not made by or affiliated with Anthropic or Google.

## Part 1: the bridge

You need:

- A Mac that stays on (macOS only for now).
- [Claude Code](https://claude.com/claude-code), signed in with your Claude account, because Remote Control needs that sign-in.
- Node 22.18 or newer.
- A Claude plan that has custom connectors and voice mode.
- A free Cloudflare account.

Steps:

```bash
git clone https://github.com/GoldenGuts/voice-bridge-claude-code-oss.git
cd voice-bridge-claude-code-oss/bridge
npm ci
scripts/setup.sh --projects ~/projects
```

Use the folder that holds your projects for `--projects`. Sessions can only start inside it.

The script asks you to sign in to Cloudflare the first time. It deploys the Worker, makes the secrets and
starts a background agent on your Mac. Then:

1. Show your connector URL: `cat ~/.voice-bridge/connector-url.txt`. **Treat it like a password.**
2. Open claude.ai, then Settings, then Connectors, then **Add custom connector**. Paste the URL. Leave the sign-in fields empty.
3. Open a Claude voice chat on your phone and turn the connector on. Say "what is Claude Code doing?".

Things you can say:

- "Is there anything I need to look into?"
- "Start a session in my-app and add a pricing page."
- "Use Opus at high effort as the orchestrator, with Sonnet helpers, and build the travel app."
- "Start a new project called budget tracker. It should ..."
- "What did the billing session finish with?" (sessions from the desktop app and the terminal count too)
- "Tell the billing session to add a refund button." (it can be open in a terminal or the desktop app)
- "Allow it." or "Tell it no, and use the staging database."

Details, tools and troubleshooting: [bridge/README.md](bridge/README.md).

## Part 2: the earphone button

You need an Android 12 or newer phone, the Claude app, and any earphones with a button: Bluetooth or wired.

1. Download `voice-trigger.apk` from [Releases](https://github.com/GoldenGuts/voice-bridge-claude-code-oss/releases) and install it.
2. Open **Voice Trigger** and follow the steps on the screen:
   1. Turn on notification access. If Android says "Restricted setting", open App info, tap the top-right menu, and choose **Allow restricted settings**.
   2. Allow "display over other apps".
   3. Tap **Connect Claude** and allow the widget.
   4. Tap **Set earphone button**, then press the button on your earphones the way you want to use it.

### Which button should I pick?

Earphones do not tell the phone which side you pressed. They send a command: play/pause, next track or
previous track. Most earphones use different commands on each side, so left and right can still do
different things. For example: left double tap sends "previous track" and can open Claude, and right double tap
sends "next track" and can open Gemini.

Pick a command you can give up. Every press you do not map still goes to your music app as normal.

The earphones' "voice assistant" gesture does not work here. Android handles that gesture itself, and we found
no way for an app to catch it. If nothing happens when you press during setup, your earphones used that
gesture or kept the press to themselves (for example, for volume). Pick another gesture.

Details and limits: [android/README.md](android/README.md).

## Safety

Read this before you share or use a connector URL.

- **Anyone with your connector URL can start Claude Code sessions on your Mac.** Do not paste it in chats or
  commit it. If it leaks, run `scripts/setup.sh --rotate` and add the connector again.
- Sessions run in Claude Code's `auto` permission mode, so routine actions do not ask. Anything else shows
  up as a question you answer by voice. `bypassPermissions` is refused. If your plan has no auto mode, or you want to
  approve everything, set `"permissionMode": "default"` in `~/.voice-bridge/config.json`.
- The bridge can also send messages to sessions that are open on your Mac, if they are inside your project
  folder. Each message arrives marked as coming from another session, and that session's permission rules still apply.
- The agent accepts Claude Code's "trust this folder" question for you, for folders inside your project
  folder only. Keep only code you trust in that folder.
- Each person deploys their own Worker. Nothing goes to a shared server. Session summaries go through your
  Worker to claude.ai, and voice chats follow your Claude account's rules.
- Voice Trigger has no internet permission. It holds notification access to hear buttons and control music. It does
  not read notifications.

More: [SECURITY.md](SECURITY.md).

## What has been tested

| Thing | How |
| --- | --- |
| Bridge | Setup script from zero on macOS, then a real session through a real Worker. Daily use in Claude voice mode on Android. 18 automated tests. |
| Messages to open sessions | A real open session on Claude Code 2.1.318, sent through the real tool. Not yet tried in voice mode. |
| Earphone app: keys, music forwarding, calls | On a Motorola edge 30 (Android 17) with simulated key presses and a test music app. 7 automated tests. |
| Earphone app: opening Claude and Gemini | The same widget code has opened both on a Samsung Galaxy Z Flip7 (Android 17). |
| Real earphones from different brands | Not yet. Please open an issue with what yours send. |

## Thanks

[talk-to-claude-code](https://github.com/osaighi/talk-to-claude-code) (MIT) worked out how to message an open Claude Code session.

## License

[MIT](LICENSE)

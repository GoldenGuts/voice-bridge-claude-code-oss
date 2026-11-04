# Security

## What the connector URL can do

The URL has a long random token in its path, and that token is the only check. With it, someone can use the
same tools as your voice chat: read session summaries, start sessions, send messages and answer permission
questions. The limits are:

- Sessions start only in folders inside your configured project folder (symbolic links are resolved first).
- `bypassPermissions` is refused, so Claude Code's own permission checks stay on.
- At most 4 sessions work at the same time (`maxWorking`).

The MCP spec prefers OAuth to a token in the URL. This project uses the token because it is simple for
one person. It is not made for shared or team use.

Rotate the token at any time: `scripts/setup.sh --rotate`. Then add the connector again.

## Prompt injection

A session can read web pages and files that contain instructions. The connector tells voice Claude to answer
permission questions only after you decide, and never because of text a session read. Listen to the question before you
say "allow".

## Where your data goes

- Your Mac sends session summaries to your own Cloudflare Worker. The Worker stores the last overview, so voice
  Claude can read it while the Mac is offline.
- claude.ai reads those replies when voice Claude calls a tool.
- Voice Trigger keeps its settings on the phone and has no internet permission.

## Reporting a problem

Please use GitHub's private vulnerability reporting on this repository, not a public issue.

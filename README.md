# Claude Dashboard

A local web dashboard for every Claude Code session running on this machine: live status,
the prompt each session started with, every action taken, flashing alerts when a session
needs you, one-click Approve/Deny for permission prompts, and a launcher for new sessions.

Zero dependencies. Nothing leaves localhost. See [DESIGN.md](DESIGN.md) for the full design.

## Platform support

Built for **macOS + iTerm2**, where everything works. The dashboard has two halves that
degrade differently:

| | Watching sessions (cards, statuses, flashing, feeds) | Interacting (send, approve/deny, end, terminal mirror, new session) |
|---|---|---|
| macOS + iTerm2 | ✅ | ✅ |
| macOS, other terminals (Terminal.app, Alacritty, kitty, …) | ✅ | ❌ — needs iTerm2's AppleScript API |
| Linux / Windows (WSL) | ⚠️ untested — reads the same `~/.claude` files | ❌ — a tmux backend would enable this (planned in DESIGN.md) |
| Windows native | ⚠️ untested | ❌ — Windows Terminal has no API to type into an existing pane |

Watching only requires reading `~/.claude`; interaction requires a scriptable terminal,
and iTerm2 is the only backend implemented today (isolated in `server/src/services/iterm.js`
— adding another terminal means implementing those same six functions).

## Quick start

```bash
./scripts/start.sh          # starts the server (if needed) and opens the browser
# or run in the foreground:
node server/src/index.js    # then open http://localhost:7777
```

Requires Node.js ≥ 18 (already present — Claude Code runs on it) and iTerm2 for the
interactive features. The first send/focus/launch triggers a one-time macOS permission
dialog ("…wants to control iTerm2") — click OK.

## What you see

- **Summary bar** — Total / Need attention / Awaiting your reply / Turn complete /
  Working. Click a tile to filter the grid; click again to clear.
- **Session cards** — one per live session, attention-needing first:
  - 🔴 `waiting` (e.g. permission prompt) → flashing red border, tab title flashes too
  - 🟡 `reply` (Claude finished but **you still have to act** — it asked a question, or it drafted a deliverable like a review that was never posted/pushed anywhere) → amber pulse + the closing text shown on the card
  - ⚪ `done` (turn fully complete, nothing pending) → calm card, no animation
  - 🟢 `busy` (working) → calm card, breathing dot
- Per card: project, full cwd, pid, model, uptime, the **starting prompt** (click to
  expand), and a live **activity feed** of tool calls, errors, prompts, and replies.
- A `waiting` card also shows **the pending question** — the exact command awaiting
  permission (`❓ wants to run Bash — cd /repo && git push…`) or the question Claude
  asked — plus a **terminal mirror**: the bottom of the actual pane, so you see the
  permission dialog verbatim, including Claude Code's safety warning, before approving.

## What you can do

| Action | How |
|---|---|
| Approve / Always / Deny a permission prompt | quick-action buttons on a flashing card |
| Deny with guidance | **✎ Deny & redirect** — sends Esc, then type what to do instead |
| Send any message to a session | composer at the bottom of each card |
| Answer a menu without submitting | untick the ⏎ toggle, send raw keys like `1` |
| Jump to the terminal | **Open in iTerm ↗** — raises that exact iTerm2 pane |
| Start a new session | **＋ New Session** — pick a recent project dir, optionally a **skill** (like typing `/my-skill` in Claude, with your prompt as its arguments), and an initial prompt; launches `claude` in a new iTerm2 window and the card appears automatically |
| End a session | **✕** on the card — interrupts, sends `/exit`, closes the iTerm2 pane (asks for confirmation) |

## How it works

```
~/.claude/sessions/<pid>.json   live registry written by Claude Code (status: busy|idle|waiting)
~/.claude/projects/**/*.jsonl   transcripts → starting prompt + action feed
~/.claude/history.jsonl         recent project dirs for the New Session picker
ITERM_SESSION_ID (process env)  pid → exact iTerm2 pane, driven via AppleScript
```

One Node process (`server/`) reads those sources, pushes snapshots to the browser over
SSE every 1.5 s, and injects keystrokes via `osascript`. The web app (`web/`) is static
vanilla HTML/CSS/JS served by the same process.

## Layout

```
claude-dashboard/
├── DESIGN.md                 component design, mockups, API contract
├── scripts/start.sh          start + open browser
├── server/                   backend service (zero-dep Node)
│   └── src/
│       ├── index.js          entrypoint
│       ├── config.js
│       ├── routes/           api.js (REST + SSE) · static.js
│       ├── services/         sessionRegistry · transcript · iterm · projects · skills
│       └── utils/            fsio (bounded reads, JSONL)
└── web/                      frontend app (no build step)
    └── public/               index.html · app.js · style.css
```

## Caveats

- The `~/.claude/sessions` registry format is internal to Claude Code and may change
  between versions.
- **Approve** sends `1`, **Always** sends `2`, **Deny** sends Esc — matching Claude
  Code's permission dialog. If a dialog has different options, use the composer with the
  ⏎ toggle off to pick exact numbers.
- "Awaiting your action" vs "turn complete" is a heuristic: a question at the end of
  Claude's last message, or a document-shaped final message (markdown headers) whose
  turn performed no side-effecting action (nothing pushed/posted/written) → your action
  is still needed. The card banner shows the actual closing text so you can judge.

## License

[MIT](LICENSE)

# Claude Dashboard — Component Design

A local dashboard to observe and interact with every Claude Code session running on this
machine. One Node.js process (zero npm dependencies) serves a browser UI; nothing leaves
localhost.

## 1. System overview

```
┌─────────────────────────────────────────────── this machine ──────────────────────────────────┐
│                                                                                                │
│  iTerm2                                       dashboard-server (Node, :7777)                   │
│  ┌────────────┐                               ┌──────────────────────────────┐                 │
│  │ claude #1  │── writes ──► ~/.claude/       │ sessionRegistry  ◄─ scans ───┼─ ~/.claude/     │
│  │ claude #2  │             sessions/<pid>.json│ transcript       ◄─ parses ─┼─ projects/*.jsonl│
│  │ claude #3  │             projects/*.jsonl  │ iterm            ── controls─┼─► iTerm2 (osascript)
│  │ claude #4  │◄─ keystrokes (AppleScript) ───│ routes/api  routes/static    │                 │
│  └────────────┘                               └──────────────┬───────────────┘                 │
│                                                              │ SSE (live push) + REST          │
│                                               Browser  ◄─────┘                                 │
│                                               dashboard-web (vanilla HTML/JS/CSS)              │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key insight that shapes the design:** Claude Code already maintains a live registry at
`~/.claude/sessions/<pid>.json` with `status: idle | busy | waiting` and even
`waitingFor: "permission prompt"`. The dashboard never guesses session state — it reads
the same source of truth Claude Code writes. Transcripts under `~/.claude/projects/`
provide the starting prompt, every action taken, and live token usage.

**Terminal backends:** interaction is routed through pluggable backends
(`services/terminals/`). Each claude process's environment (read once via `ps -E`)
says which terminal hosts it — `TMUX` → tmux, `TERM_PROGRAM=iTerm.app` → iTerm2,
`TERM_PROGRAM=Apple_Terminal` → Terminal.app; anything else renders as an observe-only
card. All backends implement the same six operations (sendText, sendKey, focus,
closePane, readScreen, sessionTitle) plus spawnSession. New-session launches pick
iTerm2 → Terminal.app → tmux, first available (`CLAUDE_DASH_SPAWN=iterm|terminal|tmux`
overrides).

| Backend | Mechanism | Caveats |
|---|---|---|
| iTerm2 | AppleScript (`write text`, `text of session`) | one-time "control iTerm2" permission |
| Terminal.app | AppleScript `do script` + System Events keystrokes | Esc/raw keys need Accessibility permission and focus the window; window-level titles only |
| tmux | tmux CLI (`send-keys`, `capture-pane`) — works on Linux and under any host terminal | `focus` selects the pane but can't raise the host window |

## 2. Processes / apps

| App | Folder | Tech | Role |
|---|---|---|---|
| dashboard-server | `server/` | Node.js ≥18, no deps | Scans registry + transcripts, pushes live state over SSE, drives iTerm2 (send input, focus panes, launch new sessions) |
| dashboard-web | `web/` | Vanilla HTML/CSS/JS, no build step | Summary bar with filters, session cards, flashing alerts, quick actions, composer, New Session dialog |

A single `node server/src/index.js` runs everything; the web app is static files served
by the same process. `scripts/install-launchd.sh` installs it as a macOS launchd user
agent (starts at login, restarts on crash, logs to `~/Library/Logs/claude-dashboard.log`).

## 3. UI design

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Claude Dashboard                                          [＋ New Session]        live │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ┌────────────────┬─────────┬────────────────┬──────────────────────┬───────────────┐ │
│ │ 4              │ 1       │ 1              │ 1                    │ 1             │ │
│ │ Total sessions │ Working │ Need attention │ Awaiting your action │ Turn complete │ │
│ └────────────────┴─────────┴────────────────┴──────────────────────┴───────────────┘ │
│   (tiles are clickable filters — click "Need attention" to see only those cards)      │
│                                                                                        │
│ ╔══════════════════════════════════════╗  ┌──────────────────────────────────────┐   │
│ ║ 🔴 api-service      PERMISSION PROMPT ║  │ 🟡 webapp             AWAITING · 12m │   │
│ ║ ~/code/api-service  pid 41023         ║  │ ~/code/webapp                        │   │
│ ║ opus-4-8 · up 2h 5m                   ║  │ pid 38117 · opus-4-8 · up 3h         │   │
│ ║ STARTED WITH                          ║  │ STARTED WITH                         │   │
│ ║ ▌"investigate the OOM in the parser…" ║  │ ▌"write a design doc for the new…"   │   │
│ ║ ┌───────────────────────────────────┐ ║  │ ┌──────────────────────────────────┐ │   │
│ ║ │20:31 Bash   run pytest tests/     │ ║  │ │19:55 Read   .../design-spec.md   │ │   │
│ ║ │20:32 ✗ Bash exit 1: 3 failed      │ ║  │ │19:58 claude "Draft is ready for…"│ │   │
│ ║ │20:33 Edit   src/parser.py         │ ║  │ └──────────────────────────────────┘ │   │
│ ║ │20:34 claude "May I run git push?" │ ║  │ [Send a message…  ] [⏎][Send][Open ↗]│   │
│ ║ └───────────────────────────────────┘ ║  └──────────────────────────────────────┘   │
│ ║ ❓ wants to run Bash — git push origin main                                          │
│ ║ [✓ Approve][✓✓ Always][✗ Deny][✎ Deny & redirect]                                   │
│ ║ [yes, go ahead…        ] [⏎][Send][Open in iTerm ↗]                                 │
│ ╚══════════════════════════════════════╝  (🟢 busy cards render calm, no animation)   │
└──────────────────────────────────────────────────────────────────────────────────────┘
   ╔══╗ = card border FLASHING red          🟡 = soft amber pulse        🟢 = steady
```

### Session card anatomy (one per live session)

| Zone | Content | Behavior |
|---|---|---|
| Header | status dot + **session title** + rename (✎) + status badge | title auto-derives from the terminal title Claude Code sets (a live task summary), falling back to the first prompt, then folder name; ✎ sets a custom title (persisted in `~/.claude-dashboard/titles.json` by sessionId; empty reverts) |
| Meta row | project · full cwd, pid, model, uptime, `ctx <n> · ↑<n>` live tokens | monospace, subdued |
| "Started with" | first real user prompt of the session | clamped to 3 lines; click to expand |
| Activity feed | last 40 actions: tool calls (`⚙ Bash — run pytest`), your prompts, Claude's replies, tool errors (`✗`) | auto-scrolls to newest unless you scrolled up |
| Question banner | one compact line (full text on hover): for `waiting` — the pending tool call with the **literal command** (`wants to run Bash — cd /repo && git log…`) or AskUserQuestion text, in red; for `reply` — Claude's closing question, in amber | hidden for `done`/`busy`; pending tool = most recent tool call with no result in the transcript |
| Terminal mirror | the bottom ~40 lines of the session's actual pane while `waiting` — the permission dialog exactly as rendered, including the command and Claude Code's safety warning ("this command changes directory before running git…"), which exist only on screen, not in any file | fetched from iTerm2 (`text of session`) once per waiting episode; hidden otherwise |
| Quick actions | Approve / Always / Deny / Deny-&-redirect | only visible while the card is `waiting` |
| Composer | text input + ⏎ toggle + Send + Open in iTerm ↗ | see interactions below |
| End (✕ in header) | interrupt (Esc) → `/exit` → wait for process exit → close the iTerm pane | confirmation asked; refuses (409) if the session won't exit |

Every action button follows the same lifecycle: pressed-down scale on click, dimmed +
disabled while the request is in flight, a brief green "✓ done" state on success, then
back to normal; failures restore the button and show an error toast. Quick actions exist
in the DOM only while their card is `waiting`.

### Status → visual language

The registry reports `busy | idle | waiting`. The server refines `idle` into two derived
states using two transcript signals (heuristics — see trade-offs):

1. **Question at the end** — the last message asks the user something (`?`, "let me
   know", "should I…").
2. **Undelivered deliverable** — the last message is a structured document (markdown
   headers, e.g. a drafted review) **and** the final turn ran no side-effecting action
   (no `git push`/`git commit`, `gh pr review|comment|merge`, mutating `gh api`/`curl`,
   mutating MCP calls, or file writes). The work product exists only in the chat, so the
   user still has to do something with it. A review *posted to GitHub* in that turn
   counts as delivered → `done`; the same review only printed in chat → `reply`.

| Derived status | Meaning | Visual |
|---|---|---|
| `busy` | Claude is working | green dot, gentle breathing, calm card |
| `reply` | Claude finished **but the user still has to act** — a question is pending or a deliverable hasn't left the chat | amber dot, soft border pulse, amber banner showing the closing text |
| `done` | turn fully complete — nothing pending, ready for a new prompt | gray dot, calm card, no animation |
| `waiting` (+ `waitingFor`) | hard-blocked on you — e.g. permission prompt | **red flashing border + background strobe**, badge shows the reason, red banner shows the exact pending tool call/question |
| process gone | session exited | card disappears |

Cards auto-sort: `waiting`, then `reply`, then `done`, then `busy`. The browser tab title
also flashes (`🔴 1 waiting — Claude Dashboard`) so you see it from any other tab.

### Summary bar (top of page)

Clickable stat tiles, doubling as filters for the grid (click again to clear):

```
┌──────────┬─────────┬────────────────┬──────────────────────┬───────────────┐
│ 4        │ 1       │ 1              │ 1                    │ 1             │
│ Total    │ Working │ Need attention │ Awaiting your action │ Turn complete │
└──────────┴─────────┴────────────────┴──────────────────────┴───────────────┘
```

### Quick actions (shown only on a `waiting` card)

```
[✓ Approve]  [✓✓ Always]  [✗ Deny]  [✎ Deny & redirect]
     │            │           │              │
   sends 1      sends 2    sends Esc    sends Esc, focuses the composer
                                        so you type what to do instead
```

## 4. User interactions

1. **Glance** — open `http://localhost:7777`; every live session appears as a card within ~1.5s, updating live over SSE (no refresh ever needed).
2. **Spot trouble** — a session that needs you flashes red (permission prompt) or pulses amber (turn finished, waiting for your next prompt). Tab title flashes too.
3. **Read the story** — each card shows where the session runs (cwd), what prompt started it, and a scrolling feed of every action: tools used, files touched, commands run, errors hit, what Claude last said.
4. **Reply without switching windows** — type in the composer, hit Send → the text is typed into that session's iTerm2 pane and submitted.
5. **Answer menus/permission prompts** — untick the ⏎ toggle to send raw characters without Enter (e.g. `1` to choose an option).
6. **Jump to the terminal** — "Open in iTerm ↗" raises that exact iTerm2 tab/pane for full manual control.
7. **One-click permission handling** — flashing cards show Approve / Always / Deny / Deny-&-redirect buttons that inject the matching keystrokes.
8. **Start a new session from the UI** — ＋ New Session opens a dialog with a recent-projects picker (from `~/.claude/history.jsonl`), an optional **skill picker** (user + project skills/commands, like typing `/` in Claude; the prompt field becomes the skill's arguments), and an optional initial prompt; the server opens a **new iTerm2 window**, `cd`s there, runs `claude "<prompt>"` (e.g. `claude "/review-pr 1234"`), and the new card appears on the dashboard within seconds (the session registers itself).
9. **Triage by status** — summary tiles filter the grid to just waiting / reply / done / busy sessions.
10. **End a session** — ✕ on the card (with confirmation) interrupts, sends `/exit`, and closes the pane once the process exits.
11. **Rename a session** — ✎ next to the title; empty input reverts to the auto title.
12. **Watch live usage** — a strip under the summary tiles totals context-in-use and recent output tokens across active sessions (recomputed from transcripts every tick, no persisted/stale stats); each card shows its own `ctx · ↑output`.
13. **Observe-only degradation** — sessions in unscriptable terminals keep full observation; their composer/buttons are disabled with an explanatory placeholder.

## 5. Backend components

```
server/src/
├── index.js                  entrypoint: http server + route dispatch
├── config.js                 ports, paths, parse limits
├── routes/
│   ├── api.js                REST + SSE endpoints, title/status enrichment
│   └── static.js             serves web/public
├── services/
│   ├── sessionRegistry.js    scan ~/.claude/sessions, liveness-check pids, enrich, sort
│   ├── transcript.js         JSONL parsing: first prompt, action feed, model, tokens
│   ├── customTitles.js       user-set titles (~/.claude-dashboard/titles.json)
│   ├── projects.js           recent project dirs from ~/.claude/history.jsonl
│   ├── skills.js             skill/command discovery (~/.claude + <cwd>/.claude)
│   └── terminals/
│       ├── index.js          backend dispatcher: env detection → route, spawn picker
│       ├── procEnv.js        pid → {TERM_PROGRAM, TMUX, ITERM_SESSION_ID, tty} via ps -E
│       ├── iterm.js          iTerm2 via AppleScript
│       ├── appleTerminal.js  Terminal.app via AppleScript + System Events
│       └── tmux.js           tmux CLI (pid ancestry → pane)
└── utils/
    └── fsio.js               bounded head/tail file reads, JSONL parse, truncate
```

### API contract

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/sessions` | GET | snapshot of all live sessions |
| `/api/events` | GET (SSE) | pushes the snapshot whenever it changes (1.5s poll) |
| `/api/sessions/:pid/send` | POST `{text, pressEnter}` | type into the session's pane |
| `/api/sessions/:pid/key` | POST `{key}` | inject a key: `1`, `2`, `escape`, `enter`, `up`, `down`, `tab` |
| `/api/sessions/:pid/focus` | POST | raise the pane in iTerm2 |
| `/api/sessions/:pid/screen` | GET | bottom of the pane's visible text (terminal mirror) |
| `/api/sessions/:pid/title` | POST `{title}` | set a custom title; empty clears the override |
| `/api/sessions/:pid/end` | POST | Esc → `/exit` → close pane; 409 if the session won't exit |
| `/api/projects` | GET | recent project dirs for the New Session picker |
| `/api/skills?cwd=` | GET | skills/commands available for a session in that dir |
| `/api/sessions/new` | POST `{cwd, prompt?}` | open a new iTerm2 tab and launch `claude` there |

### Send-message sequence

```
UI Send ─► POST /send ─► ps -E <pid> → ITERM_SESSION_ID (cached)
                       ─► osascript: find iTerm2 session by id → write text (no newline)
                       ─► wait 300 ms, then send Enter as a separate keystroke
```

The two-step write matters: Claude Code's TUI treats a burst of input as a paste, so a
newline sent together with the text is absorbed into the pasted content instead of
submitting it. Typing first and sending Enter after a short pause submits reliably.

## 6. Design decisions & trade-offs

- **Read Claude's own state files instead of heuristics** — status is exact, including *why* a session is waiting. Trade-off: file format is undocumented/internal, could change between Claude Code versions (it's versioned in the file, easy to adapt).
- **Zero npm dependencies** — `node server/src/index.js` just works; nothing to install, audit, or update.
- **SSE over WebSockets** — one-directional live updates are all we need; SSE is simpler and auto-reconnects natively.
- **Bounded transcript reads** (head 256 KB / tail 512 KB) — transcripts grow to many MB; the dashboard stays O(1) per refresh regardless of session age.
- **Pluggable terminal backends, detected per session** — each session is routed by what actually hosts it (its env), so mixed setups (some sessions in iTerm2, some in tmux) work simultaneously. Unsupported terminals degrade to observe-only cards rather than failing clicks.
- **tmux as the portability path** — the tmux backend uses only the tmux CLI, so it carries interaction to Linux/WSL and any host terminal.
- **Live usage from transcripts, not persisted stats** — `~/.claude/stats-cache.json` lags by up to a day; the dashboard computes context-in-use and recent output from the live transcript tails instead. Recent-output is the tail window's sum, not a lifetime total (kept bounded by design). Plan limits aren't persisted locally by Claude Code, so they are deliberately not shown.
- **Subagent (sidechain) events filtered out** of the feed — keeps the action feed readable; the main-chain Agent tool call still shows.
- **`reply` vs `done` is a heuristic** — question detection plus the undelivered-deliverable check. Side-effect matching is deliberately invocation-shaped (`git push`, `gh pr comment`) rather than word-shaped: "show PR commits" must not count as a delivery. It can still misclassify; the cost of an error is just a wrong tile/animation, and the banner shows the actual closing text so the user can judge.

## 7. Possible future extensions

- Session history view (ended sessions, durations, outcomes)
- Desktop notifications (Notification API) when a session flips to `waiting`
- Backends for kitty / WezTerm (both have remote-control CLIs)
- Lifetime token totals per session (incremental transcript offsets instead of tail windows)

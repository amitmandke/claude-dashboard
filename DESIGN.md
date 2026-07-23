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
overrides). When nothing is running, the iTerm2 backend launches the app itself
(`open -b com.googlecode.iterm2`) and polls until it answers AppleScript before
creating the window — creating a window mid-launch fails with opaque AppleEvent errors.

| Backend | Mechanism | Caveats |
|---|---|---|
| iTerm2 | AppleScript (`write text`, `text of session`) | one-time "control iTerm2" permission |
| Terminal.app | AppleScript `do script` + System Events keystrokes | Esc/raw keys need Accessibility permission and focus the window; window-level titles only |
| tmux | tmux CLI (`send-keys`, `capture-pane`) — works on Linux and under any host terminal | `focus` selects the pane but can't raise the host window |

## 2. Processes / apps

| App | Folder | Tech | Role |
|---|---|---|---|
| dashboard-server | `server/` | Node.js ≥18, no deps | Scans registry + transcripts, pushes live state over SSE, drives iTerm2 (send input, focus panes, launch new sessions), and runs the Slack watcher poll loop (candidate producer, see §5) |
| dashboard-web | `web/` | Vanilla HTML/CSS/JS, no build step | Three in-page tabs (Sessions / Candidates / Watchers): summary bar with filters, session cards, flashing alerts, quick actions, composer, New Session dialog; the Candidates tab lists launchable pending work with a text filter; the Watchers tab shows each watcher's live state with Pause/Resume/Run-now and global Stop-all/Start-all |

A single `node server/src/index.js` runs everything; the web app is static files served
by the same process. `scripts/install-launchd.sh` installs it as a macOS launchd user
agent (starts at login, restarts on crash, logs to `~/Library/Logs/claude-dashboard.log`).
The log records every interaction (`ACTION send|key|focus|end|spawn|ai-title …`) and every
failed request (`ERROR <method> <path>: <message>`), so misbehavior is diagnosable after
the fact.

## 3. UI design

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Claude Dashboard  [Sessions][Candidates ③]  [🌙]                    [＋ New Session]  │
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
│ ║ [yes, go ahead…        ] [⏎][Send][⎋ Esc][Open in iTerm ↗]                          │
│ ╚══════════════════════════════════════╝  (🟢 busy cards render calm, no animation)   │
└──────────────────────────────────────────────────────────────────────────────────────┘
   ╔══╗ = card border FLASHING red          🟡 = soft amber pulse        🟢 = steady
```

### Session card anatomy (one per live session)

| Zone | Content | Behavior |
|---|---|---|
| Header | status dot + **session title** + rename (✎) + status badge | title precedence: ✎ custom title (persisted in `~/.claude-dashboard/titles.json` by sessionId; empty reverts) → AI-derived title (see below) → the terminal title Claude Code sets → the first prompt → folder name |
| Meta row | project · full cwd, pid, model, uptime, `ctx <n> · ↑<n>` live tokens | monospace, subdued |
| "Started with" | first real user prompt of the session | clamped to 3 lines; click to expand |
| Activity feed | last 40 actions: tool calls (`⚙ Bash — run pytest`), your prompts — including skill/slash-command invocations, rendered as `/review-pr 1234` — Claude's replies, tool errors (`✗`) | auto-scrolls to newest unless you scrolled up; **Claude entries are clickable** — marked with a ⤢ arrow and a hover highlight (echoing the Open-in-iTerm ↗ convention) — feed text is truncated to 200 chars, clicking fetches the complete message on demand (`/text?at=`) and renders it as styled markdown in a scrollable popup (`md.js`, a zero-dep renderer with regex-based syntax tinting for code fences; input HTML-escaped; popup theme replicates the "Markdown Reader" Chrome extension's dark theme — Atom One Dark palette, blue `#6785e0` primary) |
| Live progress line | the spinner line Claude Code renders in the pane while working — `✽ Germinating… (1m 57s · ↓ 6.7k tokens)` — so a `busy` card shows the same motion you'd see in the terminal | polled from the pane (`/screen`) every ~2s while `busy`, matched by glyph + gerund + `(stats)` shape (not by "esc to interrupt", which the shortcut-hint bar also contains); breathing teal; hidden for other statuses |
| Question banner | one compact line (full text on hover): for `waiting` — the pending tool call with the **literal command** (`wants to run Bash — cd /repo && git log…`) or AskUserQuestion text, in red; for `reply` — Claude's closing question, in amber | hidden for `done`/`busy`; pending tool = most recent tool call with no result in the transcript; clicking the amber banner opens the full-reply markdown popup |
| Terminal mirror | the bottom ~40 lines of the session's actual pane while `waiting` — the permission dialog exactly as rendered, including the command and Claude Code's safety warning ("this command changes directory before running git…"), which exist only on screen, not in any file | fetched from iTerm2 (`text of session`) once per waiting episode; hidden otherwise |
| Quick actions | Approve / Always / Deny / Deny-&-redirect | only visible while the card is `waiting` |
| Composer | text input + ⏎ toggle + Send + ⎋ Esc + Open in iTerm ↗ | see interactions below; ⎋ Esc sends a bare Esc — interrupts the running turn or dismisses a menu (always available, unlike Deny which only shows while `waiting`); lights up red while the session is `busy` (there's a turn to interrupt), dull gray otherwise |
| Expand (⛶ in header) | lift the card into a large centered overlay (≈960px × 88vh, drag the bottom-right corner to resize up to 96vw × 92vh) over a dimmed backdrop | same DOM node, so the live feed/composer/quick-actions keep working while expanded; collapse via ⛶ / Esc / backdrop click drops it back into its exact grid spot at the default size (the drag-resize inline width/height are cleared on collapse); one card expanded at a time |
| End (✕ in header) | interrupt (Esc) → `/exit` → wait for process exit → close the iTerm pane | ending kills the session's context, so confirmation is status-aware: `done` closes silently (nothing to lose); `busy`/`waiting`/`reply` confirm with a message naming what would be lost (in-progress turn, pending approval, unanswered question); refuses (409) if the session won't exit |

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

Cards auto-sort: `waiting`, then `reply`, then `done`, then `busy` — oldest session first
within a status. The grid re-orders live as statuses change, except while the cursor is
inside a card (moving a DOM node would drop focus mid-typing); it catches up on the next
tick after focus leaves. The browser tab title also flashes
(`🔴 1 waiting — Claude Dashboard`) so you see it from any other tab.

### Summary bar (top of page)

Clickable stat tiles, doubling as filters for the grid (click again to clear). The
"Need attention" tile flashes red (same animation as `waiting` cards) whenever its
count is above zero:

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
  sends the   sends the     sends Esc    sends Esc, focuses the composer
  "Yes" digit "don't-ask"                 so you type what to do instead
  (usually 1) digit
```

The digit each button sends is **parsed from the live dialog** (mirrored on screen),
not assumed — see `web/public/dialog.js`. Claude Code drops the "don't ask again" line
for commands it can't form a reusable allow-rule for (e.g. a compound `cd X && git …`),
leaving a **two-option** menu where option 2 is *"No … (esc)"*. Blindly sending `2`
there would deny the tool, so **Always is shown only when the prompt actually offers a
don't-ask-again option**; on a two-option dialog it is hidden. Approve maps to the "Yes"
digit (option 1), Deny always sends Esc.

### Candidates view (second tab)

A **candidate session** is a session you *could* launch but haven't yet — a concrete plan
(`cwd` + optional skill + prompt) waiting in a list with a **reason** and a **priority**.
It decouples *"something proposes work"* from *"a session actually runs"*: nothing spawns
until you choose it. Candidates have several **producers** — a running Claude session that
discovers follow-up work and calls `POST /api/candidates`, the **Add to candidates** button
on the launch page, the **New candidate** form in the UI, and a **Slack watcher** that
stages threads which @-mention you (see §5, *Slack watchers*). All converge on one list.

The dashboard is still **one page and one SSE stream**: a header **tab toggle** flips
between the Sessions view (everything above) and the Candidates view. The Candidates tab
carries a **count badge** of pending items, visible from either tab so you notice new work
without switching.

```
 Claude Dashboard  [Sessions][Candidates ③]  [🌙]              [＋ New Session]
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ [ Filter — skill, prompt, reason, directory…        ]  3 pending  [＋ New]   │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ ┌────────────────────────────────┐  ┌────────────────────────────────┐      │
 │ │ /review-pr          P2         │  │ /debug          P1             │      │
 │ │ Review the PR linked in #eng   │  │ Investigate the null deref…    │      │
 │ │ reason: failing CI on auth     │  │ reason: stack trace in #eng    │      │
 │ │ ~/code/api-service · session ↗ │  │ ~/code/webapp · manual         │      │
 │ │ [▷ Launch][▲][▼][⌥ Skill][✕]   │  │ [▷ Launch][▲][▼][⌥ Skill][✕]   │      │
 │ └────────────────────────────────┘  └────────────────────────────────┘      │
 └────────────────────────────────────────────────────────────────────────────┘
```

Each card leads with a derived **title** (a PR as `repo #123`, else "Slack thread", else the
first prompt line) and **link chips** (a PR link and/or a 💬 Slack-thread link, opened in a new
tab), so the "what is this" is scannable rather than buried. Below that: the **skill** chip, the
**reason**, the **prompt** (clamped to 3 lines with a ▾ more toggle to expand, and a separate ✎
to edit — so reading doesn't fight editing), the directory, and the **source/producer**. The
`ref` may be a plain URL or an object (`url` / `slackPermalink` / `prRefs`); the title/chips
handle both. The **filter** box narrows the
visible cards by case-insensitive substring across skill / prompt / reason / cwd / source —
purely client-side, since the full list is already in the snapshot. Per-card actions:

| Action | Effect |
|---|---|
| **▷ Launch** | spawn it via the same path as New Session; the candidate is marked `launched` and a normal live card appears on the Sessions tab. Disabled (with an "N working" hint) when the count of **actively-working** sessions (busy/waiting) is at `maxConcurrent`. |
| **▲ / ▼** | raise / lower priority; the list re-sorts (higher launches first, oldest-first within a priority) |
| **⌥ Skill** / click the prompt | edit the plan before launching (skill / prompt) |
| **✕ Dismiss** / **↩ Restore** | drop a pending item / restore a dismissed one |
| **✕ Clear** | remove a `launched`/`dismissed` item from the list immediately |

`launched` and `dismissed` items stay in the list (greyed, still filterable) as a short
history of what was proposed and what you did with it. They auto-prune on a retention sweep —
`launched` quickly (hours, since it's already a live session), `dismissed` after a few days —
or you can **✕ Clear** one right away.

## 4. User interactions

1. **Glance** — open `http://localhost:7777`; every live session appears as a card within ~1.5s, updating live over SSE (no refresh ever needed). Connection health is silent when good — a red "reconnecting…" appears in the header only while the stream is down.
2. **Spot trouble** — a session that needs you flashes red (permission prompt) or pulses amber (turn finished, waiting for your next prompt). Tab title flashes too.
3. **Read the story** — each card shows where the session runs (cwd), what prompt started it, and a scrolling feed of every action: tools used, files touched, commands run, errors hit, what Claude last said.
   **Read a full reply** — click any Claude entry in the feed (or the amber reply banner) to open the complete message, rendered as markdown in a scrollable popup (close: ✕, Esc, or click outside).
4. **Reply without switching windows** — type in the composer, hit Send → the text is typed into that session's iTerm2 pane and submitted.
5. **Answer menus/permission prompts** — untick the ⏎ toggle to send raw characters without Enter (e.g. `1` to choose an option).
6. **Jump to the terminal** — "Open in iTerm ↗" raises that exact iTerm2 tab/pane for full manual control.
7. **Interrupt a running turn** — ⎋ Esc in the composer row sends a bare Esc to the pane, exactly like pressing Esc in the terminal (stops the current turn; the session stays alive and waits for new instructions).
8. **One-click permission handling** — flashing cards show Approve / Always / Deny / Deny-&-redirect buttons that inject the matching keystrokes.
9. **Start a new session from the UI** — ＋ New Session opens a dialog with a recent-projects picker (from `~/.claude/history.jsonl`), an optional **skill picker** (user + project skills/commands *and enabled-plugin skills*, like typing `/` in Claude; the prompt field becomes the skill's arguments), and an optional initial prompt (Enter launches, Shift+Enter inserts a newline, matching Claude Code's composer); the server opens a **new iTerm2 window**, `cd`s there, runs `claude "<prompt>"` (e.g. `claude "/review-pr 1234"`), and the new card appears on the dashboard within seconds (the session registers itself).
10. **Triage by status** — summary tiles filter the grid to just waiting / reply / done / busy sessions.
11. **End a session** — ✕ on the card interrupts, sends `/exit`, and closes the pane once the process exits. A `done` card closes without asking; a working/blocked/awaiting card asks for confirmation first, since ending terminates the session's context and in-progress work.
12. **Rename a session** — ✎ next to the title; empty input reverts to the auto title.
13. **Watch live usage** — a strip under the summary tiles totals context-in-use and recent output tokens across active sessions (recomputed from transcripts every tick, no persisted/stale stats); each card shows its own `ctx · ↑output`.
14. **Observe-only degradation** — sessions in unscriptable terminals keep full observation; their composer/buttons are disabled with an explanatory placeholder.
15. **Switch theme** — the header button cycles 🌗 auto (follows the system appearance, live) → ☀️ light → 🌙 dark; auto is the default, an explicit choice persists across visits.
16. **Expand a card** — ⛶ in the card header blows it up to a large centered, resizable overlay for a roomier feed/mirror; ⛶ again, Esc, or a backdrop click returns it to its grid spot.
17. **Queue work as a candidate** — switch to the **Candidates** tab to see launchable pending work (added by a running session, the launch page's "Add to candidates", or the New candidate form). Filter the list, reprioritize (▲/▼), edit the skill/prompt, then **Launch** (becomes a live session) or **Dismiss**. The tab's count badge surfaces new candidates while you're on the Sessions tab.

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
│   ├── aiTitles.js           AI-derived titles via headless `claude -p` (cache: ai-titles.json)
│   ├── projects.js           recent project dirs from ~/.claude/history.jsonl
│   ├── skills.js             skill/command discovery (~/.claude + <cwd>/.claude + enabled plugins)
│   ├── candidates/
│   │   └── store.js          launchable candidate list (~/.claude-dashboard/candidates.json)
│   ├── watchers/             Slack watcher — candidate producer (see "Slack watchers" below)
│   │   ├── index.js          per-watcher runtime (Map): poll loop, pipeline (runWatcherOnce), pause/resume/run-now
│   │   ├── config.js         load/validate watchers.json (fail-closed); trigger + intent map
│   │   ├── state.js          persistent cursor + tracked threads + seen dedupe (watchers-state.json)
│   │   ├── slack.js          zero-dep Slack Web API client (read-only; injectable transport)
│   │   ├── repos.js          owner/repo → local checkout, auto-discovered from git remotes
│   │   ├── match.js          mention detection, noise filter, PR-ref extraction, thread render
│   │   └── classify.js       headless `claude -p` intent matcher (reuses the aiTitles machinery)
│   └── terminals/
│       ├── index.js          backend dispatcher: env detection → route, spawn picker
│       ├── procEnv.js        pid → {TERM_PROGRAM, TMUX, ITERM_SESSION_ID, tty} via ps -E
│       ├── iterm.js          iTerm2 via AppleScript
│       ├── appleTerminal.js  Terminal.app via AppleScript + System Events
│       └── tmux.js           tmux CLI (pid ancestry → pane)
└── utils/
    └── fsio.js               bounded head/tail file reads, JSONL parse, truncate, atomic JSON write
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
| `/api/sessions/:pid/text?at=` | GET | full text of the assistant message at that transcript timestamp (feed entries are truncated to 200 chars to keep SSE light) |
| `/api/sessions/:pid/title` | POST `{title}` | set a custom title; empty clears the override |
| `/api/sessions/:pid/end` | POST | Esc → `/exit` → close pane; 409 if the session won't exit |
| `/api/projects` | GET | recent project dirs for the New Session picker |
| `/api/skills?cwd=` | GET | skills/commands available for a session in that dir |
| `/api/sessions/new` | POST `{cwd, prompt?, skill?}` | open a new iTerm2 tab and launch `claude` there; `skill` is composed into a leading `/skill` (with `prompt` as its arguments) server-side, so callers needn't know the slash-command convention. Returns `{ok, cwd, prompt}` — the new pid isn't known synchronously (the card appears on the next scan). |
| `/api/candidates` | GET | the candidate list (also carried in the SSE snapshot) |
| `/api/candidates` | POST `{cwd, skill?, prompt?, priority?, reason?, source?, producer?, ref?, dedupeKey?}` | add a fully-specified candidate; reuses `/sessions/new`'s validation; deduped on `dedupeKey`; rejected (429) past `maxPending`. Returns `{id}`. |
| `/api/candidates/:id` | PATCH `{prompt?, skill?, priority?}` | edit / reprioritize a candidate |
| `/api/candidates/:id/launch` | POST | spawn it (same path as `/sessions/new`), mark `launched`; 409 at the `maxConcurrent` cap |
| `/api/candidates/:id/dismiss` · `/undismiss` | POST | mark `dismissed` / restore to `pending` |
| `/api/candidates/:id` | DELETE | remove the item from the list now (the ✕ Clear action) |
| `/api/watchers` | GET | watcher status: per-watcher `state` (running/paused/error/disabled), last poll time, staged count, last error |
| `/api/watchers/:name/{pause,resume,run}` | POST | pause a watcher (persists `enabled:false`), resume it (persists `enabled:true`), or run one poll now |
| `/api/watchers/{stop-all,start-all}` | POST | pause / resume every watcher at once |

The SSE snapshot is `{sessions, candidates, caps:{maxConcurrent, maxPending}, now}` — the
candidate list rides the same 1.5 s diff-and-push loop, so any add/edit/launch/dismiss/clear
reaches every open dashboard immediately. A once-a-minute retention sweep piggy-backs the
snapshot tick, pruning aged-out history: `launched` items after a short window (hours — set
by `launchedRetentionHours`, they're already live sessions) and `dismissed` items after
`retentionDays`.

### Send-message sequence

```
UI Send ─► POST /send ─► ps -E <pid> → ITERM_SESSION_ID (cached)
                       ─► osascript: find iTerm2 session by id → write text (no newline)
                       ─► wait 300 ms, then send Enter as a separate keystroke
```

The two-step write matters: Claude Code's TUI treats a burst of input as a paste, so a
newline sent together with the text is absorbed into the pasted content instead of
submitting it. Typing first and sending Enter after a short pause submits reliably.

### Launching from other tools (launch links)

`POST /api/sessions/new` is the canonical launch API; the New Session form and any
external caller (a script, an MCP tool, or another Claude session) hit the same endpoint
with `{cwd, prompt?, skill?}`. For the common case of one session handing off work to a
new one, the dashboard serves a confirmation page at **`/launch.html?cwd=…&prompt=…&skill=…`**:
a Claude session can emit that URL in its output, and clicking it opens a page that shows
the target directory, skill, and prompt with a **Launch** button. The button is what calls
the POST API — the bare link never spawns on its own. This keeps the action off a plain
GET (no drive-by spawns from link prefetch or an accidental click) while still being a
single clickable link, and it lets the user see exactly what will run before it does. The
page offers two buttons: **Launch now** (spawns immediately) and **Add to candidates**
(stages it on the Candidates tab for later review), so the emitting session lets you pick
immediate vs. queued-for-review.

### Slack watchers (candidate producer)

A **watcher** watches a Slack channel and turns threads that **@-mention you** into
candidate sessions. It never launches or posts anything — it only *produces* candidates you
review. It runs inside the dashboard server process (started at boot), so it works whenever
the machine is up, independent of whether a browser tab is open.

**Configuration** lives in `~/.claude-dashboard/watchers.json` (local, git-ignored; the repo
ships `watchers.example.json` with placeholders only). Validation is **fail-closed**: a
watcher with no channels or no trigger users does not run — there is no "watch everything".
Each watcher declares:

- `channels` — Slack channel IDs the bot has been invited to.
- `trigger` — what makes a thread worth looking at. One type (the shape leaves room for
  `keyword`/`reaction` later):
  - `{ type: "mention", users:[…] }` — a channel thread qualifies when one of those users is
    @-mentioned **anywhere in it, including a late reply**.
- `intents` — an **intent → skill map**: `[{ name, description, skill }]`. This is the point
  of control: the classifier's only job is to match a thread to one named intent (or none),
  and the **skill is taken from this map, not chosen by the model**. With an empty list the
  classifier falls back to picking a skill freely (looser, less controlled).
- `poll.everySeconds` (floored at 30) and `action.preferCheckout`.

**Polling with a persistent cursor** (`state.js` → `watchers-state.json`) is the reliability
backbone. Each poll asks Slack's `conversations.history` for messages `oldest` = the saved
cursor, so **anything posted while the machine was asleep is backfilled** on the next poll
(Socket Mode was rejected precisely because it drops events during downtime). Slack's history
endpoint doesn't return thread replies, so a `@you` that lands deep in an existing thread is
caught by re-scanning tracked threads' `conversations.replies` each tick — bounded by a
retention window and a thread cap (both configurable); the bound is logged, never silent.

**Pipeline per qualifying thread** (`index.js` → `runWatcherOnce`): fetch the whole thread →
match it to an intent via `classify.js` (headless `claude -p --model haiku`, reusing the
`aiTitles.js` machinery: subscription-billed, no API key, run hidden in `~/.claude-dashboard/headless`
with `CLAUDE_DASH_INTERNAL=1`, one-at-a-time with a failure fallback) → if an intent matches,
**stage a candidate**. The skill comes from the intent map; the **repo (`cwd`), launch
prompt, and reason are derived deterministically** (repo from PR links via `repos.js`
auto-discovered from git remotes, falling back to the watcher's optional `action.cwd`; prompt
= a link back + PR refs + the thread text) — the LLM does not author them. If the classifier is unavailable the thread is still staged as
*unclassified* (never dropped) for you to fill in. Dedupe is keyed by `channel:thread_ts`, so
socket/poll overlap or a re-scan never double-stages, and a decided thread (matched or not) is
marked `seen` so it isn't re-classified.

The token is resolved from a reference in config (`slack.botToken`), never stored inline in the
repo. Three schemes, resolved by `config.resolveToken`: `keychain:<service>[:<account>]` (macOS
Keychain via the `security` CLI — encrypted, and never placed in `process.env` so it isn't
inherited by the headless `claude -p` children), `@/abs/path` (a `chmod 600` file), or
`$ENV_VAR`. Scopes are read-only (no `chat:write`), so a watcher structurally cannot post.

**Runtime & controls.** Each configured watcher is one entry in a `Map` (state ∈
`running`/`paused`/`error`/`disabled`), so one can be controlled without touching the others or
the dashboard. The **Watchers tab** shows each watcher's state, last poll, staged count, and last
error, with **Pause / Resume / Run-now** per watcher and **Stop-all / Start-all** globally.
Pause/Resume **persist** to `watchers.json` (`config.setEnabled` flips `enabled`, preserving all
other fields) so they survive a restart; a paused watcher comes back paused. Status rides the SSE
snapshot (`watchers` key) so the tab is live. A pristine **first run baselines** (records the
cursor, stages nothing) so an existing channel's backlog isn't dumped as candidates; only a
saved cursor drives backfill on later runs.

The Slack client (`slack.js`) is coverage-excluded like the terminal backends (pure network),
while the pipeline + control logic (`runWatcherOnce`, pause/resume, config/state/match/classify/repos)
is unit-tested against a stub client and an injected timer.

## 6. Design decisions & trade-offs

- **Read Claude's own state files instead of heuristics** — status is exact, including *why* a session is waiting. Trade-off: file format is undocumented/internal, could change between Claude Code versions (it's versioned in the file, easy to adapt).
- **Zero npm dependencies** — `node server/src/index.js` just works; nothing to install, audit, or update.
- **SSE over WebSockets** — one-directional live updates are all we need; SSE is simpler and auto-reconnects natively.
- **Bounded transcript reads** (head 256 KB / tail 512 KB) — transcripts grow to many MB; the dashboard stays O(1) per refresh regardless of session age.
- **Pluggable terminal backends, detected per session** — each session is routed by what actually hosts it (its env), so mixed setups (some sessions in iTerm2, some in tmux) work simultaneously. Unsupported terminals degrade to observe-only cards rather than failing clicks.
- **tmux as the portability path** — the tmux backend uses only the tmux CLI, so it carries interaction to Linux/WSL and any host terminal.
- **Live usage from transcripts, not persisted stats** — `~/.claude/stats-cache.json` lags by up to a day; the dashboard computes context-in-use and recent output from the live transcript tails instead. Recent-output is the tail window's sum, not a lifetime total (kept bounded by design), and is summed per API message id — the transcript repeats the same `usage` on every content-block line of one response, so a per-line sum would inflate 3-5×. Plan limits aren't persisted locally by Claude Code, so they are deliberately not shown.
- **AI-derived titles via headless `claude -p`, not the API** — the terminal title Claude Code writes summarizes only the *latest exchange*, so a side question ("is it stuck?") renames a PR-review session. `aiTitles.js` instead feeds the starting prompt plus the recent activity feed to Claude and asks for the session's *primary task*, weighing sustained activity over the last message. It shells out to `claude -p --model haiku` (draws on the user's existing subscription; no Console account or `ANTHROPIC_API_KEY` required) rather than calling the API. Cost controls: regenerate only when a session gains a new user turn (tracked by a per-session turn key, cached with the title in `~/.claude-dashboard/ai-titles.json`), one generation at a time, 2-minute back-off after failures, 90s timeout. Headless runs execute in `~/.claude-dashboard/headless` with a `CLAUDE_DASH_INTERNAL=1` env marker; the session registry skips any registry entry with that cwd, so the dashboard's own workers never show up as cards. Opt out with `CLAUDE_DASH_AI_TITLES=0`; on any failure the title chain silently falls back to the terminal title.
- **Dark and light themes via CSS variables only** — every color in `style.css` lives in a variable on `:root` (dark, the default) with a complete counterpart under `[data-theme="light"]`; no rule hardcodes a color. The header toggle cycles three modes — 🌗 auto (follows `prefers-color-scheme` live, so scheduled OS day/night switching works), ☀️ light, 🌙 dark — flipping `data-theme` on `<html>`. Auto is the default (nothing stored); an explicit choice persists in `localStorage`, and an inline `<head>` script applies the resolved theme before the stylesheet loads (no flash). The reply popup follows the "Markdown Reader" extension's matching theme pair (one-dark / one-light). Deliberate exception: the terminal mirror stays dark in both themes — it mirrors a real terminal pane.
- **Subagent (sidechain) events filtered out** of the feed — keeps the action feed readable; the main-chain Agent tool call still shows.
- **Candidates are inert data, launched explicitly** — a candidate is a stored plan, not a running thing; the producer API (`POST /api/candidates`) can't make anything spawn on its own, so a session or external tool proposing work never bypasses your review. Launch reuses the exact `/sessions/new` validation + spawn path (no second way to start a session), and is gated by `maxConcurrent` — counted over **actively-working** sessions (busy/waiting), not idle/turn-complete windows, so it caps *load* rather than open windows (default is a high backstop) — so a backlog can't flood the machine; `maxPending` bounds the list (adds past it are rejected and logged, never silently dropped). The list is a single JSON file written atomically by the one event loop — same single-writer pattern as titles/AI-titles, no locking. **In-page tabs, not a second page**: the Candidates view shares the one SSE stream, theme, and toast plumbing — it's a view toggle, so launching a candidate and watching it become a live card stays within one app.
- **Slack watchers poll (never Socket Mode), and the LLM only matches an intent** — polling with a persistent cursor backfills anything posted while the machine was asleep; a real-time socket would silently drop exactly those events, so it was rejected for an intermittently-running tool. And the classifier is scoped as narrowly as possible: it names a configured intent (or none) and nothing else — the skill comes from the config map and the repo/prompt are derived deterministically — so what launches stays under explicit user control, not model whim. Read-only scopes mean a watcher can never post.
- **`reply` vs `done` is a heuristic** — question detection plus the undelivered-deliverable check. Side-effect matching is deliberately invocation-shaped (`git push`, `gh pr comment`) rather than word-shaped: "show PR commits" must not count as a delivery. It can still misclassify; the cost of an error is just a wrong tile/animation, and the banner shows the actual closing text so the user can judge.

## 7. Possible future extensions

- **Watchers management panel.** Watchers are configured today by hand-editing
  `watchers.json`; the UI only shows read-only status. A guided panel to create/edit/enable
  watchers (pick trigger → channel → users → intent→skill map, with validation and a preview
  of what will match) is a deliberate follow-up — the emphasis is explicit control over how a
  watcher is added, made easy to use. It overlaps with a future settings panel.
- **More watcher triggers & post-back.** The trigger shape is built for `keyword`/`reaction`
  beyond `mention`; and a `postBack: propose` mode could let a launched session draft a reply
  into the originating Slack thread for one-click approval (adds `chat:write`, kept out of the
  read-only first cut). A `POST /api/candidates/from-text` endpoint would let a running session
  hand free text to the same intent classifier.
- Session history view (ended sessions, durations, outcomes)
- Desktop notifications (Notification API) when a session flips to `waiting`
- Backends for kitty / WezTerm (both have remote-control CLIs)
- Lifetime token totals per session (incremental transcript offsets instead of tail windows)

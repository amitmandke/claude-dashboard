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
| dashboard-web | `web/` | Vanilla HTML/CSS/JS, no build step | Three in-page tabs (Sessions / Candidates / Watchers): summary bar with filters, session cards, flashing alerts, quick actions, composer, New Session dialog; the Candidates tab lists launchable pending work with a text filter; the Watchers tab shows each watcher's live state with Pause/Resume/Run-now, global Stop-all/Start-all, and create/edit/delete via a trigger-picker + staged editor dialog |

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
 │ │ [▷ Launch][▲][▼][✕ Dismiss]    │  │ [▷ Launch][▲][▼][✕ Dismiss]    │      │
 │ └────────────────────────────────┘  └────────────────────────────────┘      │
 └────────────────────────────────────────────────────────────────────────────┘
```

Each card leads with a derived **title** (a PR as `repo #123`, else the **Slack channel name**
`#channel`, else "Slack thread", else the first prompt line) and **link chips** (a PR link
and/or a 💬 `#channel` link, opened in a new tab), so the "what is this" is scannable rather than
buried. Below that: the **skill** chip, the **reason**, the **prompt** (clamped to 3 lines with a
▾ more toggle), the directory, and the **source/producer**. **✎ Edit** opens the candidate
**dialog** (the same modal as ＋ New candidate, in edit mode) — a roomy popup with a resizable
prompt textarea, a Folder input with recent-project suggestions (`<datalist>` from `/api/projects`),
and a Skill dropdown of the folder's real skills — and saves via the PATCH above (no `prompt()`
popups). The `ref` may be a plain URL or an object (`url` / `slackPermalink` /
`channelName` / `prRefs`) — the watcher attaches `channelName` at stage-time; the title/chips
handle both. The **filter** box narrows the
visible cards by case-insensitive substring across skill / prompt / reason / cwd / source —
purely client-side, since the full list is already in the snapshot. Per-card actions:

| Action | Effect |
|---|---|
| **▷ Launch** | spawn it via the same path as New Session; the candidate is marked `launched` and a normal live card appears on the Sessions tab. Disabled (with an "N working" hint) when the count of **actively-working** sessions (busy/waiting) is at `maxConcurrent`. |
| **▲ / ▼** | raise / lower priority; the list re-sorts (higher launches first, oldest-first within a priority) |
| **✎ Edit** | flip the card into an inline form to edit skill / folder / reason / prompt before launching |
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
│   ├── watchers/             candidate producers — trigger → candidates (see "Watchers" below)
│   │   ├── index.js          per-watcher runtime (Map): poll loop, pipeline (runWatcherOnce), pause/resume/run-now
│   │   ├── config.js         watchers.json schema v2: load/validate (fail-closed), v1→v2 migration, bots + rules
│   │   ├── state.js          per-channel cursor + tracked threads + seen dedupe (watchers-state.json)
│   │   ├── slack.js          zero-dep Slack Web API client (read-only; injectable transport)
│   │   ├── pace.js           the one queue every Slack call goes through: serial, paced, 429-adaptive
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
| `/api/candidates/:id` | PATCH `{prompt?, skill?, cwd?, reason?, priority?}` | edit / reprioritize a candidate (the card's inline ✎ Edit form saves these) |
| `/api/candidates/:id/launch` | POST | spawn it (same path as `/sessions/new`), mark `launched`; 409 at the `maxConcurrent` cap |
| `/api/candidates/:id/dismiss` · `/undismiss` | POST | mark `dismissed` / restore to `pending` |
| `/api/candidates/:id` | DELETE | remove the item from the list now (the ✕ Clear action) |
| `/api/watchers` | GET | watcher status: per-watcher `state` (running/paused/error/disabled), last poll time, staged count, last error, and per-channel `{ id, name, watchingSince, paused, excluded }` — `paused` and `excluded` are reported separately so a row can say *why* it isn't scanning |
| `/api/watchers/:name/{pause,resume,run}` | POST | pause a watcher (persists `enabled:false`), resume it (persists `enabled:true`), or run one poll now |
| `/api/watchers/:name/cursor` | POST | move a channel's "watch from" point: `{ channel, at }` (`at` = `"now"` or a date); clears that channel's tracked threads/seen |
| `/api/watchers/:name/channel/{pause,resume}` | POST | pause / resume a single channel (`{ channel }`); a paused channel is skipped every poll, state kept — the *temporary* counterpart to the durable `excludeChannels` denylist |
| `/api/watchers/{stop-all,start-all}` | POST | pause / resume every watcher at once |
| `/api/watchers/config` | GET | the editable config: each watcher in v2 raw shape (what a save patches, so a Raw-JSON view round-trips) plus `{ ref, label, tokenRef, resolves }` per bot — references only, never a resolved token |
| `/api/watchers/bots` | GET | bots with their live identity from `auth.test` (`{ user, team, botId }`); an unresolvable reference or a rejected token comes back as that bot's `error`, not a failed request |
| `/api/watchers/folders` | GET | folder choices for the editor: every discovered checkout path (both copies of a twice-cloned repo, unlike the resolve map) |
| `/api/watchers/channels?botRef=` | GET | live channel list for one bot (`users.conversations`): `{ id, name, isPrivate, archived }`, paginated + capped, public-only when `groups:read` is missing |
| `/api/watchers` | POST | create a watcher; the body is the patch (`{ name, enabled, trigger, rules, prompt, poll, action }`). 400 carries the fail-closed reason |
| `/api/watchers/:name` | PUT/POST | update a watcher (same patch shape, merged onto the stored one); `{ name }` renames. 400 on an invalid result — nothing is written |
| `/api/watchers/:name` | DELETE | remove a watcher from the config and stop it |

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

### Watchers (candidate producers)

A **watcher** is one idea: a **trigger that produces candidates**. It never launches or posts
anything — it only *produces* candidates you review. It runs inside the dashboard server
process (started at boot), so it works whenever the machine is up, independent of whether a
browser tab is open. Two trigger types exist in the schema:

- **`slack`** — poll a bot's channels; a thread that **@-mentions you** and matches a rule
  stages a candidate. This is the implemented pipeline, described below.
- **`schedule`** — run a saved prompt as an ephemeral session that finds work and stages
  candidates. The schema validates these and the Watchers tab reports them, but the runner
  does **not** execute them yet: `config.normalize` hands the Slack poll loop only `slack`
  watchers, so a trigger type nothing can run can never reach it. Design: `docs/proposals.md`
  Proposal 6.

**Configuration** lives in `~/.claude-dashboard/watchers.json` (local, git-ignored; the repo
ships `watchers.example.json` with placeholders only), at **schema `version: 2`**. Validation
is **fail-closed**: a slack watcher with no channels or no mention users does not run — there
is no "watch everything" — and a schedule watcher with no prompt does not run. The file
declares a **bots map** plus a list of watchers:

- `slack.bots` — `{ <ref>: { token, label } }`, one entry per Slack bot (a bare string is
  shorthand for `{ token }`). `token` is always a *reference*, never the secret (see below).
  A watcher points at one bot with `trigger.botRef` (default: `"default"`); an unknown ref
  resolves to no token, which fails closed.
- `trigger` — what fires the watcher:
  - `{ type:"slack", botRef, channels, mentions:[…] }` — a channel thread qualifies when one
    of `mentions` is @-mentioned **anywhere in it, including a late reply**. `channels` is the
    list of channel IDs the bot has been invited to — **all listed channels are scanned** (in
    parallel, each with its own independent cursor) — or the string **`"auto"`** to
    **auto-discover** every channel the bot is a member of (via `users.conversations`,
    paginated) and scan them all: invite the bot to a channel and it just appears, no config
    edit. Discovery prefers public + private but degrades to public-only when the token lacks
    `groups:read` (private channels also need `groups:history` to read anyway).
    **`excludeChannels`** is the denylist that makes `"auto"` practical: keep discovering
    everything the bot joins, but never scan these. It is what makes a busy alert channel free
    rather than expensive — a channel nobody scans should not keep costing calls — so excluding
    one also **drops its tracked threads and seen-markers**, reclaiming the tracked-thread
    budget, while leaving `cursor`/`since` intact so un-excluding backfills the gap instead of
    skipping it. Ids are stored, not names (a rename must not silently re-enable a channel), and
    the list is never reconciled against discovery: an id for a channel the bot has left stays
    excluded, so re-inviting the bot cannot quietly resume something muted on purpose. An
    explicit `channels` list fully covered by the denylist is refused at load (fail-closed);
    `"auto"` plus a denylist never is, since discovery may still find others.
  - `{ type:"schedule", everyMinutes | at:"HH:MM" | cron }` — `at` alone means daily.
- `rules` — the **when → then map**: `[{ name, about, action }]`, where `action` is
  `{ type:"skill", skill }` or `{ type:"prompt", prompt }`. This is the point of control: the
  classifier's only job is to match a thread to one named rule (or none), and the **action is
  taken from this map, not chosen by the model**. With an empty list the classifier falls back
  to picking a skill freely (looser, less controlled). The runner executes `skill` actions
  today; a `prompt` action normalizes to an empty skill until the runner learns it.
- `prompt` — the producing task, for a `schedule` watcher; optional `skill` runs it as
  `/<skill> <prompt>` (validated like any skill name; the runner will use it when it lands).
- `poll.everySeconds` (floored at 30), `action.preferCheckout`, `action.cwd`.

**Editing a watcher** goes through `config.saveWatcher` → `watchers.upsertWatcher`. Three
properties make hand-written config safe to edit from a UI: the save **patches only the keys an
editor owns** (`name`, `enabled`, `trigger`, `rules`, `prompt`, `poll`, `action`) and merges the
nested blocks shallowly, so unknown fields and `//` comments survive a round trip; it
**validates fail-closed before writing** (the merged watcher is normalized as if enabled, and a
result that couldn't run is rejected with its reason instead of saved dead); and it writes
**atomically after a one-time `.bak`**. A save then **reconciles just that watcher's runtime**
(`watchers.reconcile`) — restart it if runnable, park it `paused` if only `enabled:false`, mark
it `disabled` with the reason if the config can't run it, forget it if deleted — so an edit
takes effect immediately without touching any other watcher and without a server restart. A
rename retires the old runtime entry; the deleted/renamed watcher's cursors in
`watchers-state.json` are deliberately left in place, so re-creating that name resumes watching
where it left off rather than re-baselining. Watchers can point at **different bots**
(`trigger.botRef`): `buildDeps` keeps one Slack client per token and each poll uses its own
watcher's.

**Schema v1 is migrated at load time, in memory** (`config.migrateRaw`, idempotent), so an
older hand-written file keeps working untouched and never has to be rewritten just to upgrade
it: `slack.botToken` → `slack.bots.default`, `trigger.type:"mention"` → `"slack"`,
`trigger.users`/`mentionUsers`/`users` → `trigger.mentions`, `channels` → `trigger.channels`,
and `intents[{name,description,skill}]` → `rules[{name,about,action}]`. Unknown keys (including
the `//` comments in the example file) ride along, so the same transform can back a
merge-don't-replace save later. Normalized watchers additionally carry v1 aliases
(`mentionUsers`, `trigger.users`, `intents` derived from `rules`) for the shipped runner and
classifier, which still speak intent→skill; that alias layer is the seam to delete when they
learn `rules`. `load()` reports the on-disk `fileVersion` alongside the normalized `version`.
Every write path (today: Pause/Resume via `setEnabled`) copies the file to
`watchers.json.bak` once before its first rewrite and then writes **atomically** (temp +
rename), preserving the file's own schema version and unknown fields.

**Polling with a per-channel persistent cursor** (`state.js` → `watchers-state.json`) is the
reliability backbone. State is keyed `watcher → channel`, so each channel keeps its **own**
cursor/threads and backfills independently. Each poll asks Slack's `conversations.history` for
messages `oldest` = that channel's saved cursor, so **anything posted while the machine was
asleep is backfilled** on the next poll (Socket Mode was rejected precisely because it drops
events during downtime). Slack's history endpoint doesn't return thread replies, so a `@you`
that lands deep in an existing thread is caught by re-scanning tracked threads'
`conversations.replies` each tick — bounded by a retention window and a thread cap (both
configurable); the bound is logged, never silent. A channel's cursor is its **"last watched"**
point, surfaced per channel in the Watchers tab and **editable** (`POST /api/watchers/:name/cursor`,
`{ channel, at }` where `at` is `"now"` or a date): moving it forward skips a backlog you have
already handled by hand, and clears that channel's tracked threads/seen for a clean start.
Channel **names** (e.g. `#eng-prov`) are resolved once via `conversations.info` and cached in
state; until the app is reinstalled with the read-only `channels:read`/`groups:read` scope the
tab falls back to showing the raw channel id.

**Pipeline per qualifying thread** (`index.js` → `runWatcherOnce`): fetch the whole thread →
match it to an intent via `classify.js` (headless `claude -p --model haiku`, reusing the
`aiTitles.js` machinery: subscription-billed, no API key, run hidden in `~/.claude-dashboard/headless`
with `CLAUDE_DASH_INTERNAL=1`, one-at-a-time with a failure fallback) → if an intent matches,
**stage a candidate**. The skill comes from the intent map, and the **repo (`cwd`) and reason are
derived deterministically** (repo from PR links via `repos.js` auto-discovered from git remotes,
falling back to the watcher's optional `action.cwd`). The **launch prompt is model-authored** in
the same classify call — a crisp "what's being asked + PR/Jira/thread pointers" hand-off, kept
deliberately *light*: it points the launched session at the work but does not pre-solve it
(investigation lives in the skill, which runs fresh at launch, so pre-baking a diff summary would
only duplicate that work and go stale). The classify call itself stays tool-less and read-only —
it reasons only over the thread text it's handed, never calling `gh` or MCP. `launchPromptFrom`
(a link back + PR refs + thread text) remains the deterministic fallback when the model returns no
usable prompt. If the classifier is unavailable the thread is still staged as
*unclassified* (never dropped, deterministic prompt) for you to fill in. Dedupe is keyed by **`channel:thread_ts:message_ts`** — per *mention*, not per thread — so a
re-scan or poll overlap never double-stages the same message, while a **follow-up ping in a thread
that was already decided is still a fresh ask** and does stage (keyed per thread it was silently
dropped for the whole `seen` window, which is exactly the re-ping pattern of a review thread). Both
collapse points take the **newest** qualifying message: the latest reply in a re-scan, and the
latest mention when several land in one pass — an older, already-decided mention must not mask a new
one. One candidate per thread per pass either way.

Each bot's token is resolved from a reference in config (`slack.bots.<ref>.token`), never stored
inline in the repo — the normalized bot exposes the *reference* for display and the resolved
secret only to the runner. Three schemes, resolved by `config.resolveToken`: `keychain:<service>[:<account>]` (macOS
Keychain via the `security` CLI — encrypted, and never placed in `process.env` so it isn't
inherited by the headless `claude -p` children), `@/abs/path` (a `chmod 600` file), or
`$ENV_VAR`. Scopes are read-only (`channels:history`/`groups:history` to read, plus optional
`channels:read`/`groups:read` for friendly channel names — no `chat:write`), so a watcher
structurally cannot post.

**Runtime & controls.** Each configured watcher is one entry in a `Map` (state ∈
`running`/`paused`/`error`/`disabled`), so one can be controlled without touching the others or
the dashboard. The **Watchers tab** leads with liveness — a pulsing dot + a bright, relative
**`polled <ago>`** on the meta line (the honest "is it alive" signal; polling is uniform across a
watcher's channels). Each watched channel is a row: friendly name over **`checked <ago>`**
(recent, so it reads as live) or **`paused`**, with a per-channel **pause/resume** toggle and a
**⏱** control that shows/edits its fixed "watch from" start point (the row never shows that
fixed point inline — a past timestamp there kept reading as staleness). **Watch all from now**
sets every channel's start to now at once. Watcher-level **Pause / Resume / Run-now** and
**Stop-all / Start-all** remain. Pause/Resume **persist** to `watchers.json`
(`config.setEnabled` flips `enabled`, preserving all other fields) so they survive a restart; a
paused watcher comes back paused. Status rides the SSE snapshot (`watchers` key) so the tab is
live. **Every configured watcher gets a card, including ones the loop can't run** — an
`enabled:false` one as resumable `paused`, a `schedule` one or a config error as `disabled` with
the reason on the card: the tab is where you notice a watcher that isn't working, and its ✎ is how
you fix it. A card's config-only details (rule count, and a schedule watcher's prompt + interval,
which never reach the poll loop) come from a `configMeta` map refreshed wherever config is
re-read — never per status call, which runs on every SSE tick.

**Create / edit from the UI.** **＋ New watcher** opens a **step-0 type picker** — **Slack watcher**
or **Generic watcher** (your own prompt on a cadence; `trigger.type: "schedule"` in config), with
shell-command and HTTP shown as *soon* — then the editor with that type's stages. Both end with the
**same final stage**, "where it runs & how often" (folder, then cadence), so what they share sits in
the same place instead of one dialog leading with cadence and the other burying it: Slack = bot →
channels → mentions + when→then rules → where/how-often; Generic = skill + prompt → where/how-often.
Numeric fields are plain inputs (no spinner arrows) — bounds are enforced server-side. The dialog carries a live plain-language **summary** of what the watcher will do, a live
per-rule sentence, and a **Raw JSON** toggle showing the exact patch that will be saved (editable,
for anything the form doesn't cover — the escape hatch that keeps the form from being a ceiling).
Every choice is a **picker over real data**, never free text with a guess: the bot shows who it is
signed in as (`auth.test`), channels list what that bot can actually see, skills come from the
installed catalog, and the folder field is a dropdown built from `GET /api/watchers/folders`
(discovered checkouts + recent folders) with an **Other…** escape for a path that isn't listed. Each
kind exposes exactly one folder: a Slack watcher's is the *fallback* when no PR link resolves, a
schedule watcher's is where the producer session itself opens. `action.preferCheckout` is
deliberately **not** editable here — the repo tie-break the runner actually honors is the
`CLAUDE_DASH_PREFER_CHECKOUT` env var, so a per-watcher field would have promised an effect it
doesn't have (the key is still accepted and preserved for a future runner, and reachable via Raw
JSON). Saving sends a patch
(never a whole-file rewrite) and the reply's fail-closed reason is shown inline in the dialog
rather than as a toast, next to the field that caused it. An edit deliberately omits `enabled`, so
editing a paused watcher leaves it paused. The tab's SSE re-render is suspended while the dialog is
open (same guard as the inline channel time-editor) so a snapshot can't rebuild the form mid-edit. The **first time a channel is seen** it baselines to *now* and fetches **no** history —
so nothing already posted (however recent, answered or not) is ever staged, and the first poll
stays instant even across many auto-discovered channels. From then on each poll reads only
`cursor→now` and advances the cursor to the newest message read, so a message is never re-read;
after downtime the first read is just the missed window.

**Rate limiting is a queue, not a retry.** Every Slack call — across every client, so across every
bot and every watcher — is funnelled through one shared pacer (`pace.js`): calls run **one at a
time** with a minimum gap, a 429 pauses the *whole* queue for Slack's `Retry-After` and **doubles**
the gap (to a ceiling), and a clean streak halves it back toward the floor. The problem it solves is
shape, not volume: a pass here is ~82 calls (11 channel histories + 71 thread re-scans) which spread
over a 120s interval sits inside Slack's ~50/min tier, but fired as 11 parallel per-channel chains it
arrives as a burst and earns an immediate 429. Because the queue is shared and serial, existing
`Promise.all` fan-out keeps working unchanged — it queues instead of stampeding — and a new call site
cannot defeat the limiter by forgetting to back off. Bounds are `CLAUDE_DASH_SLACK_MIN_GAP_MS`
(default 1200) and `CLAUDE_DASH_SLACK_MAX_GAP_MS`. Paced passes can outlast the poll interval, so
`tick` is **single-flight**: a tick that starts while the previous one is still running is skipped
and logged, which costs nothing because the cursor resumes exactly where the running pass leaves off.
The pacing policy is pure over an injected clock, so it is unit-tested with no timers or sockets.

The queue has **two lanes and one rate.** Background polling and interactive requests share the same
gap, backoff and serialization, but a call marked `interactive` takes the *next* slot rather than the
last. Without it a UI request queues behind the whole fan-out: opening the watcher editor mid-poll
cost 11s (a full pass, ~70s) for two calls that need ~2.3s, because `auth.test` and
`users.conversations` sit behind up to 58 paced background calls. Only the endpoints that exist to
serve the editor (`listBots`, `listChannels`) use the lane, so it can't be spread around until
everything is "urgent". Priority is ordering only — Slack sees an identical call rate either way, so
the limiter keeps its guarantee. The dialog also no longer *waits* on those calls: it opens first and
fills the bot picker and channel list in afterwards.

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
- **Slack watchers poll (never Socket Mode), and the LLM only matches an intent** — polling with a persistent cursor backfills anything posted while the machine was asleep; a real-time socket would silently drop exactly those events, so it was rejected for an intermittently-running tool. And the classifier is scoped as narrowly as possible: it names a configured rule (or none) — the skill comes from that rule's action and the repo/reason are derived deterministically, so *what* launches (which skill, which repo) stays under explicit user control, not model whim. The classifier also drafts the launch prompt, but that only shapes the *hand-off text* the session reads, not the skill/repo decision, and it's tool-less (thread text only). Read-only scopes mean a watcher can never post.
- **`reply` vs `done` is a heuristic** — question detection plus the undelivered-deliverable check. Side-effect matching is deliberately invocation-shaped (`git push`, `gh pr comment`) rather than word-shaped: "show PR commits" must not count as a delivery. It can still misclassify; the cost of an error is just a wrong tile/animation, and the banner shows the actual closing text so the user can judge.

## 7. Possible future extensions

- **Watchers management panel.** Watchers are configured today by hand-editing
  `watchers.json`; the UI only shows read-only status. Schema v2 (bots map, `trigger.type`,
  when→then `rules`) is the backend half of the follow-up: a guided panel to create/edit/enable
  watchers — step-0 trigger picker → bot → channels → rules, with validation and a preview of
  what will match — plus the write endpoints it needs (create/update/delete, live channel list,
  bot list). The emphasis is explicit control over how a watcher is added, made easy to use. It
  overlaps with a future settings panel. Approved mock: `docs/watchers-mock.html`.
- **Running `schedule` watchers.** The schema accepts them; the runner does not execute them
  yet (single-instance guard, completion protocol, idle timeout, auto-close — Proposal 6 in
  `docs/proposals.md`). Until then they normalize, validate, and report as not-implemented.
- **More watcher triggers & post-back.** The trigger shape is built for `keyword`/`reaction`
  beyond a Slack mention; and a `postBack: propose` mode could let a launched session draft a reply
  into the originating Slack thread for one-click approval (adds `chat:write`, kept out of the
  read-only first cut). A `POST /api/candidates/from-text` endpoint would let a running session
  hand free text to the same intent classifier.
- Session history view (ended sessions, durations, outcomes)
- Desktop notifications (Notification API) when a session flips to `waiting`
- Backends for kitty / WezTerm (both have remote-control CLIs)
- Lifetime token totals per session (incremental transcript offsets instead of tail windows)

# Proposed changes (staging area)

> **How this file works.** This is a staging area for changes that are designed but **not
> yet built**. Each proposal below is **self-contained and logically independent** — it can
> be read, debated, and implemented on its own. When we start implementing a proposal, its
> content **graduates into `DESIGN.md`** (rewritten there as shipped behavior, holistically)
> and the item is **removed from this file**. That keeps `DESIGN.md` describing only what
> actually ships, and keeps proposals from rotting inside it.

> **Candidate sessions and the Slack watcher have shipped.** Both graduated into `DESIGN.md`
> — the `candidates.json` store + `POST /api/candidates` + Candidates tab, and the Slack
> **watcher** candidate producer (§5). What remains here are follow-ups on the watcher and a
> parked idea.

**Contents**

1. [Slack watchers — SHIPPED (graduated to DESIGN.md §5)](#proposal-1--slack-watchers--shipped)
   - 1a. [Watchers management panel (deferred)](#proposal-1a--watchers-management-panel-deferred)
2. [Slack "activity" watcher (parked)](#proposal-2--slack-activity-watcher-parked)
3. [Settings panel — view & edit limits/config in the UI](#proposal-3--settings-panel)

---

## Proposal 1 — Slack watchers — SHIPPED

> **Graduated to `DESIGN.md` (§5, "Slack watchers").** The Slack watcher shipped as a
> candidate producer: poll-only with a persistent cursor (backfills downtime), a `mention`
> trigger that qualifies a thread when it @-mentions you (including a late reply), whole-thread
> context, and an **intent → skill map** where the classifier's only job is to match an intent —
> the skill comes from config and the repo/launch-prompt/reason are derived deterministically.
> Config: `~/.claude-dashboard/watchers.json` (template `watchers.example.json`); read-only
> status at `GET /api/watchers`. What remains are the follow-ups below.

---

## Proposal 1a — Watchers management panel (deferred)

> **Status:** the **Watchers tab shipped** (graduated to `DESIGN.md` §5) — it shows each
> watcher's live state and offers **Pause / Resume / Run-now** and global **Stop-all /
> Start-all**, with pause persisted to `watchers.json`. Still **deferred**: **creating/editing**
> a watcher from the UI. Watchers are still *added/edited* by hand in
> `~/.claude-dashboard/watchers.json`; a guided add/edit panel is the remaining follow-up.

Requirements for the eventual panel (owner's emphasis):

- **Explicit control over how a watcher is added** — no magic/auto-created watchers; the user
  deliberately creates each one and sees exactly what it will match before it's live.
- **Very easy to use** — a guided form (pick source type → channel → user allowlist → emoji/rule
  → repo/cwd → resolve mode), not raw JSON editing. Sensible defaults, inline validation, a
  clear preview of "this watcher will stage a candidate when …".
- Writes `watchers.json` for the user (new write endpoints: create/update/delete a watcher),
  reusing the fail-closed validation the file loader already enforces.
- Overlaps conceptually with [Proposal 3](#proposal-3--settings-panel) (both expose file
  config in the UI) — decide whether they share a tab/pattern when this graduates.

---

## Proposal 2 — Slack "activity" watcher (parked)

A watcher that surfaces the high-signal slice of your Slack **Activity** — *mentions of you*
and *replies to your threads* — as candidates, so "stuff aimed at me" shows up without
hunting. Status: **parked**, pending a decision.

Key findings:

- There is **no single Slack API** that mirrors the Activity tab (it's a client-side
  aggregation). It can only be approximated.
- **Bot + allowlisted channels** (recommended): subscribe to `app_mention` / message events
  in channels the bot is in. Safe, scoped — but only covers those channels.
- **User token (`xoxp-`) + `search.messages`**: workspace-wide mention coverage without
  inviting a bot everywhere, but the token acts *as you* (bigger security/policy footprint —
  not advised for a work workspace), is search-only (no reactions), and is rate-limited.
- Default to **notify mode**: surface "you were pinged here" candidates with an optional
  one-click Launch if an item turns out to be review/debug work — not auto-spawn, no
  per-message LLM classification.

Open question: bot + allowlisted channels (recommended) vs. the user-token route for true
workspace-wide reach.

---

## Proposal 3 — Settings panel

### What it is

The dashboard already has real configuration — concurrency/list caps, candidate retention,
AI titles, the spawn backend, poll cadence — but it all lives in **environment variables**
read at startup (`config.js`). You can't see or change any of it without editing the launchd
plist and restarting. This proposal surfaces it in the UI: a **Settings** panel where you
**view** every setting and **edit** the ones that are safe to change at runtime, persisted
so they survive restarts.

A natural home is a third tab (**Sessions / Candidates / Settings**) or a ⚙ button in the
header opening a dialog — the tab strip already exists, so either is cheap.

### Settings, grouped

| Group | Setting (env var) | Editable at runtime? |
|---|---|---|
| Candidates | `maxConcurrent`, `maxPending`, `retentionDays`, `launchedRetentionHours` | **yes** — read live on each use |
| AI titles | `aiTitles` on/off, `aiTitleModel` | **yes** — read per generation |
| Live updates | `sseIntervalMs` | yes (re-arm the loop) |
| Transcript limits | `tailBytes`, `headBytes`, `maxEvents`, `fullTextBytes` | yes — read per parse |
| Launch | spawn backend (`CLAUDE_DASH_SPAWN`) | yes (affects the next spawn) |
| Server (display-only) | `port`, `host`, data dir, `claudeBin` | **no** — bound/located at startup; show with a "restart to change" note |

The split is the key design point: most values are *read each time they're used*, so a saved
change takes effect immediately; a few (`port`/`host`/paths) are fixed at process start and
are shown read-only with a restart hint rather than pretending to be live.

### How it works

- **Persistence** — `~/.claude-dashboard/settings.json` (same single-file, atomic-write,
  git-ignored pattern as `candidates.json` / titles). Precedence: **saved settings →
  environment variable → built-in default**, so an env var still works as an override/floor
  and the file only stores what the user changed.
- **`config.js` becomes layered** — today it exports frozen constants read once. It would
  instead expose a `get(key)` (or live getters) that resolves saved-file → env → default on
  each read. Modules that currently capture a constant at import (e.g. caps in the candidate
  store, `AI_TITLES` in `aiTitles.js`) switch to reading through `get()` so edits land
  without a restart.
- **API** — `GET /api/settings` (current resolved values + which are editable + source:
  default/env/saved) and `PUT /api/settings {…}` (validate, persist, apply). Reuses the
  snapshot/SSE plumbing so an open dashboard reflects a change immediately.
- **UI** — a form generated from the settings schema: numbers with min/max, toggles,
  the spawn-backend dropdown; per-row "source" hint (default / from env / saved) and a
  **Reset to default** per field. Display-only rows are rendered disabled with the restart
  note.

### Validation & safety

Bounds are enforced server-side (e.g. `maxConcurrent` ≥ 1, `retentionDays` ≥ 0,
`sseIntervalMs` within a sane floor/ceiling) — the same fail-closed spirit as elsewhere.
Localhost-only like the rest of the API. Nothing here can spawn or post; it only adjusts
limits and toggles. A malformed `settings.json` degrades to env/defaults (never a crash),
matching how the other stores handle corruption.

### Why it's worth doing

It turns invisible env knobs into something discoverable and adjustable — you can raise the
concurrency cap for a busy afternoon, flip AI titles off to save tokens, or shorten launched
retention, all from the dashboard, and see the limits the UI is actually enforcing (the
Candidates "N/M running (at cap)" hint already references `maxConcurrent` — Settings makes
that number editable instead of mysterious).

---
name: develop-dashboard
description: Use when changing the Claude Dashboard's own code — adding a feature or tab, a new watcher or candidate producer, a terminal backend, a UI change, fixing a dashboard bug, writing its tests, or opening a PR against amitmandke/claude-dashboard. For running or troubleshooting an existing install, use manage-dashboard instead.
---

# Develop the Claude Dashboard

A zero-dependency Node ≥ 18 server plus a vanilla HTML/CSS/JS frontend with **no build
step**. Both of those are deliberate and load-bearing: adding a dependency or a
bundler is a design change, not an implementation detail — propose it, don't assume it.

## Step 1 — read the design, not just the code

```bash
sed -n '1,120p' DESIGN.md      # authoritative component design; mockups, API contract, trade-offs
sed -n '1,80p' CLAUDE.md       # the traps, each one a bug that already happened
```

`DESIGN.md` is the source of truth and is expected to stay current — a change that
alters behaviour updates it **in the same PR**. `CLAUDE.md` is the accumulated
hard-won detail; read the section covering the area you are touching before writing
code, because most of it is non-obvious and cost real debugging time.

## Repo map

```
server/src/
  index.js            entry — HTTP + SSE, port 7777, localhost only
  config.js           env-var config (CLAUDE_DASH_*), resolveClaudeBin()
  routes/             api.js (all endpoints), static.js (no-cache assets)
  services/
    sessionRegistry.js  reads ~/.claude/sessions/<pid>.json
    transcript.js       parses ~/.claude/projects/<cwd>/<sessionId>.jsonl
    aiTitles.js         headless `claude -p --model haiku` card titles
    customTitles.js  projects.js  skills.js
    candidates/store.js   the launchable candidate list (single JSON file, atomic)
    watchers/           candidate producers: index (poll loop), config (schema v2),
                        state, slack, gh + reviews (GitHub review queue),
                        repos, match, classify, pace
    terminals/          dispatcher + procEnv + iterm + appleTerminal + tmux
  utils/fsio.js       atomic JSON write, safe read, truncate
web/public/           index.html, app.js, md.js, dialog.js, launch.html, style.css
test/                 node:test, one file per module
scripts/              start.sh, deploy.sh, install-launchd.sh, uninstall-launchd.sh
```

The shape to preserve: **I/O modules stay dumb, decisions live in pure modules.**
`slack.js` and `gh.js` only fetch (and are coverage-excluded for that reason);
`reviews.js`, `match.js`, `classify.js`, `transcript.js` decide and are unit-tested.
When you add a producer, follow that seam — it is what keeps the logic testable
without a network.

## Workflow

1. **Branch off `main`.** Never stack a PR on another PR's branch: a stacked branch
   whose base gets squash-merged leaves your commits orphaned and needing a
   cherry-pick rescue. `git checkout main && git pull && git checkout -b <topic>`.
2. **Design before code for anything user-visible.** For UI, produce a mock first
   (a standalone HTML file under `docs/`, which is git-ignored) and get it approved —
   consult the `frontend-design` skill; hand-built default styling reads as pale and
   gets rejected. For behaviour, state the design in the PR description or DESIGN.md.
3. **Implement**, matching the surrounding style: no framework, no build step, comments
   that explain *why* (the existing comments carry the reasoning for decisions that
   look arbitrary — keep that standard).
4. **Test.** New code ships with tests in the same PR.
5. **Run the gate locally** before pushing — CI enforces coverage thresholds and a
   red PR wastes a round trip.
6. **PR.** Describe the *why* and the trade-off, not just the diff. Update `DESIGN.md`
   and `CLAUDE.md` when behaviour or a trap changes.

## Testing

```bash
npm test                  # node --test over test/
npm run test:coverage     # exactly what CI runs, thresholds included
node --test test/reviews.test.js       # one file
```

The coverage gate is **lines 80 / branches 68 / functions 78**, scoped by
`--test-coverage-exclude` to the pure-logic modules — the DOM frontend, the terminal
backends, the routes and the two network clients are excluded because they need a
browser, real apps, or a network. `npm run test:coverage` and the CI job invoke the
same script, so they cannot drift.

What that means for you: **anything you put in a pure module must be tested**, and if
you add logic to an excluded file, the honest move is to move the logic out into a
pure module rather than let it go unexercised.

`app.js` has no DOM test harness. Its pure functions (`shownCandidates`,
`candMatches`, `sessionMatches`) can still be tested by extracting them from the
shipped file with a regex plus `new Function` — that trick has already caught two real
bugs. If you touch those, consider adding it to CI rather than doing it by hand.

## Traps that already cost real time

- **`grep` on `web/public/app.js` silently finds nothing** — one byte makes macOS
  `grep` treat it as binary. Always `grep -a`, including through `curl | grep`. A
  "verified" deploy was once reported off one such empty grep.
- **Never hardcode a color in a CSS rule.** Every color is a `:root` var with a
  `[data-theme=light]` counterpart; the terminal mirror deliberately stays dark in
  both themes. A nested `/* … */` inside a CSS comment closes it early and swallows
  the whole token block — the page then renders unstyled.
- **Candidate/session mutations must re-render immediately**, not wait for the next
  SSE tick. SSE can be flaky; a cleared card that lingers gets clicked twice and the
  second call 404s. Call the refresh explicitly after every action.
- **Derive "what is shown" in exactly one place.** Three call sites each deriving it
  separately shipped a select-all that ignored the status filter and armed the whole
  board. `shownCandidates()` is that one place.
- **A route like `/api/candidates/bulk` must be matched *before* `/api/candidates/:id`**,
  or the id pattern reads `bulk` as an id.
- **Never spawn `claude` by bare name** — use `config.resolveClaudeBin()`. The launchd
  plist pins a minimal PATH, and the native installer moved the binary; every headless
  spawn failed `ENOENT` for two days, silently in the watcher classifier. Degrade paths
  must log.
- **`gh` exits non-zero on a *partial* GraphQL success** and appends its message after
  the JSON body — one repo you lost access to would otherwise reject a whole call.
  Hence `runGh({allowPartial})` + brace-counting `extractJson`.
- **Don't screenshot the live dashboard with headless Chrome** — it spawns a second
  Chrome that collides with the user's. Verify via `curl` and the API, or run a dev
  instance on another port.
- **Don't spawn test sessions on the user's screen without warning them**, and don't
  end real ones. `PORT=7788 node server/src/index.js` gives you a safe instance —
  though note both instances share `~/.claude-dashboard/`.

## Known open work

`DESIGN.md` and `CLAUDE.md` carry the current list. The measured one worth knowing
before you touch the session cards: the dashboard wedges with several busy sessions
because every busy card polls `/api/sessions/<pid>/screen` every 2s, and the iTerm2
AppleScript walks every window × tab × session (260–340ms measured), scaling with
total iTerm panes rather than dashboard sessions. The fix order is a per-pid cache
with in-flight dedupe, then skipping the poll when the card is collapsed or the
document hidden, then single-flighting the SSE tick.

## Conventions

- Commits: imperative subject explaining the change, body explaining *why*.
- Tests: `node --test`, no test framework, no mocking library — inject dependencies.
- Config: a new knob is an env var in `config.js` with a default that keeps current
  behaviour, documented in `README.md`.
- Nothing leaves localhost. No telemetry, no external calls beyond the user's own
  `gh`/Slack tokens and their own `claude` binary.

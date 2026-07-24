# Claude Dashboard — project guide

Local web dashboard showing all Claude Code sessions running on this machine: live
status, action feeds, quick Approve/Deny with a terminal mirror for permission prompts,
session ending, and a New Session launcher with skill selection. Read `DESIGN.md` first —
it is the authoritative component design. Public repo (MIT, see `LICENSE`).

## Architecture in one paragraph

One zero-dependency Node.js (≥18) process (`server/src/index.js`, port 7777, localhost
only) reads Claude Code's own state files — `~/.claude/sessions/<pid>.json` (live
registry: `status: busy|idle|waiting`, `waitingFor`), `~/.claude/projects/<encoded-cwd>/
<sessionId>.jsonl` (transcripts → starting prompt + action feed + live token usage),
`~/.claude/history.jsonl` (recent project dirs), `~/.claude/skills|commands` +
`<cwd>/.claude/skills|commands` + enabled-plugin skills (skill picker) — and pushes snapshots to a vanilla
HTML/CSS/JS frontend (`web/public/`) over SSE. Interaction (typing into sessions,
Esc/digit keys, terminal mirror, focus, end, launch) is routed through per-session
terminal backends in `services/terminals/` — tmux, iTerm2, or Terminal.app, detected
from the claude process's env (`ps -E`: TMUX / TERM_PROGRAM); unsupported terminals
render observe-only. Session titles are AI-derived: `services/aiTitles.js` shells out to
headless `claude -p --model haiku` (subscription-billed, no API key) to summarize each
session's primary task from its prompt + activity feed, regenerating only on new user
turns (cache: `~/.claude-dashboard/ai-titles.json`); precedence is ✎ custom title
(`titles.json`) > AI title > terminal title Claude Code sets > first prompt > folder.

## Layout

- `server/src/` — `index.js` (entry), `config.js`, `routes/` (api, static),
  `services/` (sessionRegistry, transcript, customTitles, aiTitles, projects, skills,
  `candidates/store.js` = the launchable candidate list,
  `watchers/` = Slack watcher candidate producer (index=poll loop, config, state,
  slack, repos, match, classify),
  `terminals/` = dispatcher + procEnv + iterm + appleTerminal + tmux), `utils/fsio.js`
- `watchers.example.json` — template for `~/.claude-dashboard/watchers.json` (placeholders only)
- `web/public/` — `index.html`, `app.js`, `md.js` (minimal markdown renderer for the
  full-reply popup), `dialog.js` (parses the permission-dialog options out of the
  mirrored screen so quick actions send the right digit), `launch.html` (clickable
  launch/add-to-candidates confirmation page), `style.css` (no framework, no build step)
- `scripts/start.sh` — background-start + open browser; `install-launchd.sh` /
  `uninstall-launchd.sh` — run as a launchd user agent (login start, crash restart)
- `DESIGN.md` — full design: mockups, status→visual mapping, API contract, trade-offs
- `README.md` (user-facing, includes platform-support matrix) · `LICENSE` (MIT)

## Run / verify

```bash
node server/src/index.js          # foreground; http://localhost:7777
curl -s localhost:7777/api/sessions | python3 -m json.tool   # quick sanity check
```

Unit tests use Node's built-in runner (no deps): `npm test` (or `node --test`) runs
everything in `test/`. They cover the pure-logic modules — transcript parsing/heuristics,
fsio, title cleaning/sanitizing, the markdown renderer. The DOM frontend (`app.js`) and
the AppleScript/tmux backends are integration-only; verify those by running the server
with real live sessions and watching the dashboard. CI (`.github/workflows/test.yml`)
runs the tests **with coverage thresholds** on every PR — `node --test
--experimental-test-coverage` with `--test-coverage-lines=80 --test-coverage-branches=68
--test-coverage-functions=78`, scoped (via `--test-coverage-exclude`) to the pure-logic
modules; the integration-only files (routes, terminals, sessionRegistry, projects,
skills) are excluded since they can't be unit-tested without a browser/real apps. So
adding logic that drops coverage below the bar fails CI — keep the tests up. A second job
publishes the coverage % to a `badges` branch (Shields endpoint → README badge). Both the
`test` check and green tests are required to merge to `main` (branch protection). To keep
a function testable, export it (several are exported solely for tests, noted as such);
`CLAUDE_DASH_DATA_DIR` overrides the data dir so persistence tests never touch the real
`~/.claude-dashboard`.

## Hard rules & conventions

- **Zero npm dependencies.** Do not add packages; use Node builtins only. No build step
  for the web app either.
- **Keep `DESIGN.md` current and holistic** on every change: it must describe the latest
  state as one coherent doc — no changelogs, no "previously/now" framing. After editing,
  reread the whole doc and fix anything stale (mockups, component tree, API table,
  future-extensions list).
- **Keep this CLAUDE.md current** the same way when architecture, layout, or conventions
  change.
- **Never guess session state** — always read Claude Code's registry/transcripts. If a
  field seems missing, inspect the real files under `~/.claude/` before inventing
  heuristics.
- Transcript reads must stay bounded (head/tail byte caps in `config.js`) — transcript
  files grow to many MB.
- Server binds 127.0.0.1 only; keep it that way (it can type into terminals).
- **This is a public personal repo**: commits use the repo-local identity
  (`Amit Mandke <amitmandke@gmail.com>`, already configured) with `git commit -s`,
  plain commit titles (no Jira prefixes), and no machine-specific paths, project names,
  or employer references in code, docs, or examples — keep examples generic.

## Known sharp edges

- **Submitting text needs two writes**: Claude Code's TUI treats burst input as a paste
  and swallows a bundled newline, so `iterm.js` types the text without newline, waits
  300 ms, then sends Enter separately. Don't "simplify" this back to one write.
- **Spawn always opens a fresh iTerm2 window** (never a tab in the user's current
  window — that reads as tabs appearing out of nowhere) and holds a direct reference to
  the new session: right after creation, "current session of current window" can point
  elsewhere.
- **Spawning while iTerm2 is not running must launch-and-wait first**: `iterm.js
  ensureAppRunning()` starts the app via `open -b` and polls a trivial AppleScript
  query until it round-trips; sending `create window` during app startup throws opaque
  AppleEvent errors. The spawn script then polls for the new window's session/tty
  instead of trusting a fixed delay. Don't collapse this back into one tell block.
- **`[hidden] { display:none !important }` is load-bearing** in `style.css`: several
  elements use `display:flex`, which otherwise overrides the HTML `hidden` attribute and
  makes "hidden" UI (quick actions, question banner) show permanently.
- **Never hardcode a color in a CSS rule** — every color lives in a `:root` variable
  with a counterpart under `[data-theme="light"]`; a hardcoded color silently breaks
  the light theme. Exception by design: the terminal-mirror vars stay dark in both
  themes (it mirrors a real terminal pane).
- `~/.claude/sessions/*.json` is an internal Claude Code format (versioned via its
  `version` field); a Claude Code upgrade may change it — fix `sessionRegistry.js` first.
- **Skill discovery must include enabled plugins, not just the two folders.** A
  marketplace plugin ships its skill under `~/.claude/plugins/…`, NOT `~/.claude/skills`,
  so `skills.js` cross-references `settings.json` `enabledPlugins` (which are on) with
  `plugins/installed_plugins.json` (→ `installPath`, newest `lastUpdated` wins) and scans
  each install for a root `SKILL.md` (name from frontmatter, else the plugin id), plus
  `skills/` and `commands/` subtrees. Only enabled plugins count, mirroring `/`. If a
  Claude Code upgrade moves plugin state, fix `enabledPluginPaths()` — a picker missing a
  skill is almost always a new skill *source*, not a cache (there is no cache: the FS is
  read fresh per request and the UI refetches on dialog open). Scope precedence on a name
  clash is plugin < user < project.
- Quick actions read the digit to send from the **live dialog** (`dialog.js` parses
  the mirrored screen) — never assume option numbers. Claude Code shows a two-option
  menu (`1=Yes`, `2=No … (esc)`) for commands it can't build a reusable allow-rule for
  (compound commands), so a hardcoded `2` for "Always" silently *denies* there. The
  Always button is therefore hidden unless the prompt actually offers a don't-ask-again
  option; Approve maps to the "Yes" digit, Deny always sends Esc.
- **Backend test coverage is uneven**: iTerm2 is exercised continuously; Terminal.app
  and tmux backends are implemented to their documented APIs but had no live test
  environment at the time of writing — verify against a real session before relying
  on them, and expect the first Terminal.app Esc/raw-key use to trigger a macOS
  Accessibility permission prompt.
- In AppleScript, bare `tab` inside a `tell application` block can resolve to the app's
  tab *class*, not the tab character — use explicit separator strings (bit us once).
- The registry's `idle` is split into derived `reply`/`done` in `sessionRegistry.js` by
  two heuristics in `transcript.js`: `needsReply()` (question at the end of the last
  message) and `looksLikeDeliverable()` + `lastTurnSideEffect` (document-shaped final
  message with no mutating action that turn → the deliverable never left the chat).
  Side-effect matching must stay invocation-shaped (`git push`, `gh pr comment`), never
  bare word matching — "show PR commits" is read-only. Keep the UI honest by always
  showing the closing text on `reply` cards.
- **Terminal titles summarize the latest exchange, not the session's main task** —
  Claude Code retitles the window after the most recent prompt, so a side question
  ("is it stuck?") renames a PR-review session to "Investigate stuck issue". That is
  why `aiTitles.js` exists: it asks Claude (headless `claude -p`) for the *primary*
  task across the whole feed. Don't replace it with non-LLM heuristics over
  transcripts — those were rejected as guesswork.
- **AI-title workers must stay invisible**: headless runs execute with
  `cwd = ~/.claude-dashboard/headless` and `sessionRegistry.js` drops registry entries
  with that cwd — change both together or the dashboard shows (and retitles) its own
  workers, recursively. Generation is strictly one-at-a-time with a per-session turn
  key + 2-min failure back-off; don't make it per-tick or parallel, each call spawns a
  full Claude Code process (~15s).
- **Transcript `usage` repeats per line**: one assistant API response becomes several
  jsonl lines (one per content block), each carrying the same `message.usage`. Sum
  token counts per `message.id`, never per line — a per-line sum overcounts 3-5×.
- Interaction features are iTerm2-only; observation works with any terminal.
- First osascript call triggers a one-time macOS "control iTerm2" permission dialog.
- **Slack watchers poll, never Socket Mode** — a persistent cursor (`watchers-state.json`)
  backfills messages missed while the machine was asleep; a real-time socket would drop them.
  Slack's `conversations.history` omits thread replies, so late `@you` mentions are caught by
  re-scanning tracked threads' replies (bounded by retention + a thread cap). Don't "upgrade"
  to events without keeping the cursor backfill.
- **Watcher state is keyed per channel, and all configured channels are scanned.**
  `state.js` is `watcher → channels[channelId] → { cursor, name, threads }` (+ watcher-level
  `seen`, already `channel:thread` keyed); each channel has its own cursor so they backfill
  independently. `runWatcherOnce` scans every channel in `Promise.all` (parallel I/O), gathers
  qualifying threads, then classifies **serially** (the classifier is one-at-a-time — don't
  parallelize it). `mention` is the ONLY trigger (the `dm` trigger was removed — it needed
  scopes the workspace won't grant). A channel's cursor is its "last watched" point: exposed
  per channel in `getStatus`, editable via `POST /api/watchers/:name/cursor` (`setChannelCursor`
  → `state.setCursor`, which also clears that channel's threads/seen). Channel names come from
  `conversations.info` (needs read-only `channels:read`/`groups:read`; falls back to the id) and
  are cached in state. The `dm`-era single-channel `channels[0]` assumption is gone — don't
  reintroduce it.
- **`channels: "auto"` auto-discovers** every channel the bot is a member of (`discoverChannels`
  → `users.conversations`, paginated). It requests public+private and **degrades to public-only**
  on `missing_scope` (no `groups:read`) — don't drop the degrade, most bots are public-only.
  Discovered channels flow into the same per-channel scan; `getStatus`/`setChannelCursor` union
  config channels with `state.channelsOf(name)` so discovered ones show up and are editable.
- **The watcher classifier only matches an intent** — its sole output is a configured intent
  name (→ skill from the `intents` map). Repo, launch prompt, and reason are derived
  deterministically in `runWatcherOnce`; don't push those decisions back into the LLM. Keep
  scopes read-only (no `chat:write`) — the watcher must never be able to post.
- **Watcher token via env only** — `watchers.json` stores `"$SLACK_BOT_TOKEN"`, resolved from
  the environment; never write a real `xoxb-` token into config or the repo. The launchd agent
  doesn't inherit an interactive shell, so the token must be in the plist's
  `EnvironmentVariables` (or a sourced file) for the live dashboard to see it.
- `slack.js` is coverage-excluded (pure network, like the terminal backends); the rest of the
  watcher pipeline is unit-tested against a stub client — keep it that way (inject the client).
- **Watchers run as a per-watcher `Map` of entries** (running/paused/error/disabled), not a
  global timer list — so one watcher can be paused/run without touching the others. Pause/Resume
  and Stop-all/Start-all **persist** to `watchers.json` via `config.setEnabled` (flips `enabled`,
  preserving other fields) so a pause survives a restart. Tests inject `buildDeps`/`scheduleInterval`
  via `_setTestHooks` to exercise the control surface without network or real timers — keep that seam.
- **A channel's first sight baselines to NOW and fetches nothing** (`scanChannel` early-returns
  when there's no cursor). This keeps discovery instant across many channels and guarantees no
  already-posted message is staged. Don't "restore" a history fetch on first run — it was the
  cause of the multi-channel poll timing out. Every later poll reads only `cursor→now` and
  advances the cursor. Resetting `watchers-state.json` (or the ⏱ **set** control) re-baselines.
- **Two per-channel timestamps, don't conflate them** (this confused the UI repeatedly):
  `cursor` advances every poll to the newest message read — internal, drives incremental reads,
  NEVER shown (it wobbles per activity and reads as staleness). `since` is the fixed "watch from"
  floor — set at baseline and by ⏱ set, never advanced; it's what `setCursor` writes alongside
  the cursor, exposed as `watchingSince`, shown only on the ⏱ tooltip. The channel row shows
  **"checked \<poll-age\>"** (the watcher's uniform poll recency — recent, so it reads as *live*),
  or "paused". The one honest per-watcher liveness signal is `polled \<ago\>` on the meta line.
- **Per-channel pause** (`state.paused`, `setChannelPaused`, `POST /api/watchers/:name/channel/
  {pause,resume}`): `runWatcherOnce` filters paused channels out of the scan; their cursor/since
  stay put, so resuming backfills from where they left off. This is why per-channel status now
  earns a place on the row (active vs paused), where per-channel *liveness* alone would be
  redundant (all channels poll together in one tick).
- **CSS colors: only use vars that are actually defined.** `--busy-text` and `--busy-badge-bg`
  do NOT exist (an undefined var silently falls back, rendering grey — this bit the "Running"
  badge and poll-age). The defined green tokens are `--busy` (vivid), `--green-text` (soft),
  `--green-badge-bg`, `--busy-glow`. Grep the `:root` block before using a color var.

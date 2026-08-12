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
  `watchers/` = candidate producers, trigger→candidates (index=poll loop, config
  = schema v2 + v1 migration, state, slack, repos, match, classify,
  `gh`+`reviews` = the GitHub review-queue producer),
  `terminals/` = dispatcher + procEnv + iterm + appleTerminal + tmux), `utils/fsio.js`
- `watchers.example.json` — template for `~/.claude-dashboard/watchers.json` (placeholders only;
  schema v2). `docs/` (git-ignored) holds `proposals.md` + the approved `watchers-mock.html`
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
- **A launch prompt is staged in a temp file, never typed inline.** Typing
  `claude "<prompt>"` on the command line truncates a large prompt (the `write text` /
  `do script` line limit), so `spawnSession` (iterm.js + appleTerminal.js) writes the
  prompt to a `$TMPDIR/claude-dash-launch-*.txt` and builds `claude "$(cat <file>; rm -f
  <file>)"` — the typed command stays short and the shell reads the full prompt, then the
  file self-deletes. On osa failure the file is cleaned up in Node. Don't "simplify" this
  back to an inline `quoted form of prompt`.
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
- **A PR review queue cannot come from Slack — it comes from `gh`.** An org-subscribed channel
  carries repo *activity* with no reviewer field, and "X requested your review" is a DM a bot
  token structurally cannot read (`im:history` covers only DMs with the bot itself; a user token
  was rejected). The `github` watcher (`gh.js` + `reviews.js`) asks GitHub directly through the
  user's own `gh` login. Non-obvious things that bit during the build, all covered by tests:
  **(a)** `review-requested:@me` does NOT exclude PRs you already reviewed, AND submitting any
  review silently drops the PR from that search — so the watcher must run a second
  `reviewed-by:@me` query for re-reviews, and the reviewed-vs-tip-commit comparison is mandatory
  on both; **(b)** grouping must be
  key-centric, never transitive — a chain fused five unrelated PRs into one group nothing could
  name; **(c)** `SHA-256` matches a Jira-key regex, and that one coincidence chained a Dependabot
  bump into a real story, hence `jiraProjects` / the standards denylist; **(d)** GitHub reports
  Dependabot as plain `dependabot`, with no `[bot]` suffix, so suffix-matching alone lets every
  bump through; **(e)** the dedupe key embeds the tip commit so suppression and re-review are one
  rule — and because a push therefore mints a NEW key, staging must **supersede** the watcher's own
  stale *pending* cards sharing a PR with the new one, or an active PR piles up duplicate cards
  (three for one PR, live); launched/dismissed cards are history and stay. `gh.js` is coverage-excluded (pure I/O, like `slack.js`); keep the decisions in
  `reviews.js`, which is unit-tested at 100% lines. Skills come from the repo's build file, never
  the LLM — that is what keeps this producer alive when the classifier is down.
  **(f)** supersede only fires when something new STAGES, so it can never clean up after a PR that
  merged: a merged PR leaves the search queue entirely, nothing stages, and pending cards are exempt
  from retention pruning — the card would sit on the board forever. Hence the retire pass
  (`retireSuspects` → `ghClient.prStates` → `shouldRetire`): a pending card of *this* watcher whose
  PRs are ALL absent from the queue is only a **suspect**, confirmed in one aliased GraphQL call, and
  retired only when every PR resolved to `MERGED`/`CLOSED`. Absence is not proof — a withdrawn review
  request drops an open PR out too — and an *unresolved* lookup must keep the card: a stale card costs
  a click, deleting a live one loses work someone is waiting on. Capped at `RETIRE_MAX_PER_TICK` with
  the overflow logged (never a silent cap), and the whole pass is wrapped so cleanup can't fail a tick
  that already staged.
- **Never spawn `claude` by bare name — resolve it.** `config.resolveClaudeBin()` probes
  `CLAUDE_DASH_CLAUDE_BIN` → `~/.local/bin/claude` (native installer symlink) → `which` → the
  legacy `~/.claude/local/claude`. The launchd plist pins a minimal PATH that does **not**
  include `~/.local/bin`, so when Claude Code moved to the native installer every headless run
  died with `spawn claude ENOENT` — for two days. Prefer the `~/.local/bin` symlink over the
  resolved `~/.local/share/claude/versions/<v>` file so a Claude Code upgrade can't invalidate
  the path. Both `aiTitles.js` and `watchers/classify.js` spawn it, and the second failure was
  **silent**: `classify()` degrades to `fallbackPlan` on any error, so the only visible symptom
  was candidates quietly arriving with `intent=- skill=- conf=0`. That catch now logs — keep it
  logging, and when adding another degrade-on-error path, log there too.
- **Transcript `usage` repeats per line**: one assistant API response becomes several
  jsonl lines (one per content block), each carrying the same `message.usage`. Sum
  token counts per `message.id`, never per line — a per-line sum overcounts 3-5×.
- Interaction features are iTerm2-only; observation works with any terminal.
- First osascript call triggers a one-time macOS "control iTerm2" permission dialog.
- **The Sessions tab has two filters that compose (AND), and the tiles never count the
  filtered view.** The stat tiles are a *status* filter; `#sess-filter` is a substring filter
  over title/repo/path/pid/**starting prompt** — both fold into the one `card.hidden` line in
  `updateCard`, so the grid is never rebuilt to filter (cards persist; see the next bullet).
  Two traps: **`s.firstPrompt` is `{text, at}`, not a string** — joining the object into the
  haystack silently puts `[object Object]` in every session (so "object" matches all, and
  prompt search matches nothing); and the tiles must keep showing what is actually *running*,
  which is why the toolbar carries `N sessions · M shown` and the grid has two empty states
  (`#empty` = truly none, `#sess-nomatch` = filtered out). `lastAssistantText` is deliberately
  NOT matched — a hit with no visible cause on a collapsed card reads as a bug.
- **Bulk End is client-side and sequential — there is no bulk sessions endpoint.** Unlike
  candidates (one JSON file, so one atomic write), each end drives a real terminal through
  AppleScript; firing a dozen concurrently makes that backend flaky, so `sess-bulk-end` awaits
  `POST /api/sessions/:pid/end` one at a time and tallies failures by project name. The
  confirmation rule is the per-card rule applied once to the set: `done` sessions close silently,
  anything else confirms. A picked session card gets the accent rail **only** — never an accent
  border, which would overwrite the status border (red = waiting, green = working) that tells you
  what you are about to kill.
- **Candidate status is a filter, never a word in the text haystack.** `candStatus` (the `.seg`
  chips) ANDs with `candFilter`; `candMatches` must stay status-free, or a card whose *prompt*
  says "dismissed" would answer to the Dismissed chip and `☑ All shown` → Clear would take
  something the user wasn't looking at. Chip counts come from the whole list, not the filtered
  view. A selection deliberately survives a filter change (narrow → select → narrow → act once),
  so the readout and the Clear confirmation must both report `N hidden by the filter` — that
  disclosure is the price of not wiping the selection.
- **Bulk actions send an explicit id list — the server never interprets "all".** `☑ All shown`
  is a client-side convenience that ticks exactly what the filter is rendering, so a bulk verb
  can only reach cards that were on screen and counted; there is no "all" on the wire and no
  `Dismiss all`/`Clear all` endpoint to mis-scope. `POST /api/candidates/bulk` must stay matched
  **before** the `/api/candidates/:id` regex, whose `[\w-]+` reads `bulk` as an id (same trap as
  `RESERVED_WATCHER_PATHS`). `store.bulk` does one read-modify-write for the whole set — the
  per-id path would rewrite the entire JSON file once per card — and reports `skipped`/`notFound`
  rather than throwing, because a selection built seconds ago races launches in other tabs; the UI
  turns that into "Dismissed 11 · 1 had already been launched". `dismiss` refuses non-pending
  items on purpose (dismissing a launched candidate rewrites live history); `clear` deletes
  whatever it is handed. Selection state lives in the `candSel` Set and in `lastCandSig`, never in
  the DOM — the grid is rebuilt wholesale on every snapshot, so DOM-held checkboxes evaporate.
- **SSE-driven grids must not rebuild unless something structural changed.** The snapshot arrives
  every 1.5s; `grid.textContent = ''` + rebuild throws away scroll position, hover and focus, which
  reads as the tab yanking you to the top mid-scroll. Both grids guard against it with a signature of
  the render-affecting data (`lastCandSig` for candidates, `lastWatchSig` + `watchSig()` for
  watchers) and return early when it matches. The subtlety is **relative time**: `polled 40s ago`
  changes every tick with no data change, so `lastPollAt`/`staged` are excluded from the watcher
  signature and refreshed in place by `refreshWatchVolatile()` against `.watch-card[data-name]` —
  don't "simplify" by putting them back in the signature, that restores the every-tick rebuild.
  `watchEditOpen` additionally clears the signature, so the render after an inline edit closes
  rebuilds from real state instead of trusting a DOM the editor was mutating.
- **The watcher editor must open before its Slack calls, not after.** `openWatcherEditor` used to
  `await wdLoadBots()` before `showModal()`, so clicking Edit did nothing visible for as long as
  those calls took — ~1s idle, **11s measured mid-poll**, and ~70s for a full pass. The Slack-backed
  setup now runs in an `afterOpen` closure invoked after `showModal()`. Keep it that way: anything
  new in the open path that touches Slack belongs in that closure.
- **Every Slack call goes through the one shared queue in `pace.js` — never add a per-call retry.**
  `slack.js` wraps each request in `pacer.run()`: serial, minimum gap (`CLAUDE_DASH_SLACK_MIN_GAP_MS`,
  default 1200ms), and on a 429 it pauses the *whole* queue for `Retry-After`, doubles the gap to a
  ceiling, retries, then eases back after a clean streak. The queue is process-wide precisely so
  adding channels, bots, or call sites can't defeat it — a burst of parallel callers queues instead
  of stampeding. Don't "optimize" by parallelizing around it or reintroducing the old one-shot 429
  retry: the failure it fixes was ~82 calls fired as 11 parallel chains earning instant 429s (which
  silently lost late thread replies). Because paced passes can exceed the poll interval, `tick` is
  single-flight — an overlapping tick is skipped and logged, and the cursor makes that free.
  `pace.js` is pure over an injected clock/sleep so the policy is unit-tested; `slack.js` stays
  coverage-excluded. **Two lanes, one rate:** `run(task, { interactive: true })` — reached via
  `slack.createClient({ interactive: true })`, which `listBots`/`listChannels` use because they exist
  only to serve the editor dialog — takes the *next* gap slot instead of the last, so a person
  waiting on a form doesn't queue behind a poll's fan-out. It changes order only: same gap, same 429
  backoff, same serialization, so Slack cannot tell the lanes apart and the limiter is still
  undefeatable. This is also why the queue is two explicit arrays rather than the original promise
  chain — a chain can only append, so priority was impossible to express.
- **Slack watchers poll, never Socket Mode** — a persistent cursor (`watchers-state.json`)
  backfills messages missed while the machine was asleep; a real-time socket would drop them.
  Slack's `conversations.history` omits thread replies, so late `@you` mentions are caught by
  re-scanning tracked threads' replies (bounded by retention + a thread cap). Don't "upgrade"
  to events without keeping the cursor backfill.
- **Dedupe is per MENTION (`channel:thread:message_ts`), not per thread** — and both collapse
  points must take the **newest** qualifying message (`state.tsGreater` reduce over fresh replies,
  and newest-wins in the per-pass `toClassify` map). Keyed per thread, a follow-up ping in an
  already-decided thread was silently dropped for the 7-day `seen` window — the re-ping pattern of a
  PR-review thread. Taking the *first* qualifying reply instead of the newest reintroduces the bug in
  a subtler form: the old, already-decided mention masks the new ask (a test covers this).
- **`normalize()` splits runnable watchers by kind; the control surface must re-join them.**
  `cfg.watchers` is slack-only and `cfg.githubWatchers` is github-only, so the Slack poll loop can
  never be handed a trigger it cannot execute. But resume/reconcile/start-all look a watcher up
  **by name** and must find it whatever its kind — that is what `runnableWatchers(cfg)` is for.
  Two related traps: a github-only config has no Slack token, so `buildDeps` must still run (a
  null `deps` makes `tick` return silently and the watcher never fires), and a missing Slack token
  must disable the slack watchers only, not the whole feature.
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
- **The watcher classifier matches an intent AND drafts the launch prompt** — in intent mode
  its outputs are the intent name (→ skill from the `intents` map) *and* a crisp `prompt` (the
  hand-off given to the launched session). Skill, repo, and reason are still derived
  deterministically in `runWatcherOnce` — don't push *those* back into the LLM. But the prompt is
  model-authored (in both modes), because a clean "what's being asked + PR/Jira/thread pointers"
  beats the old raw thread dump; `launchPromptFrom` remains the deterministic fallback when the
  model returns nothing usable. The prompt is deliberately a **light hand-off, not a pre-solved
  brief** — investigation smarts (large-diff handling, prior-review checks) belong in the *skill*,
  which runs fresh at launch; pre-baking them here just duplicates the launched session's work and
  goes stale as the PR moves. The classify call stays tool-less/read-only (no `gh`, no MCP) — it
  only reads the thread it's handed. Keep scopes read-only (no `chat:write`) — the watcher must
  never be able to post.
- **`watchers.json` is schema v2, and v1 is migrated in memory — never on disk.** `config.js`
  entry points (`normalize`, `normalizeWatcher`, `normalizeTrigger`, `normalizeRules`) each run
  the idempotent `migrateWatcherRaw`/`migrateRaw` on their input first, so v1 and v2 raw both
  work everywhere and the user's hand-written file is never rewritten just to upgrade it
  (`load()` reports the on-disk `fileVersion`). v2 = `slack.bots.<ref>` + `trigger.type`
  (`slack`|`schedule`) + `trigger.mentions`/`channels`/`botRef` + when→then `rules[]` with
  `action:{type:'skill'|'prompt'}`. The runner and `classify.js` still speak v1 intent→skill, so
  normalized watchers carry **alias fields** (`mentionUsers`, `trigger.users`, `intents` derived
  from `rules`) — that alias layer is the seam to delete when those two learn `rules`; don't add
  new readers of it. `normalize()` hands the Slack poll loop **only `slack` watchers**;
  a valid `schedule` watcher lands in `disabled` (reason: not implemented) and in `all` (the
  full normalized list, for the future management UI) — the runner can't be handed a trigger it
  can't execute. Every config write path calls `backupOnce` (one-time `watchers.json.bak`) and
  `writeJsonAtomic`; a file-loss scare is why.
- **`repos.listCheckouts` keeps duplicates on purpose; `buildMap` collapses them.** The map is
  `owner/repo → one dir` (preferDir breaks the tie), so it can't enumerate the *other* copies of a
  twice-cloned repo — that needs the pre-collapse list, which is why `create()` caches both from one
  filesystem walk and `dirs()` (the editor's folder picker) reads the list, not the map.
- **A watcher's `action.preferCheckout` is inert — the env var is what works.** `buildDeps` builds
  the repo map with `preferDir: config.WATCHERS_PREFER_CHECKOUT` (`CLAUDE_DASH_PREFER_CHECKOUT`);
  nothing reads the per-watcher key, so `config.js` normalizes/preserves it but the editor
  deliberately doesn't offer it. Wire it through `buildDeps` (per-watcher repo map) before
  advertising it in the UI.
- **The Watchers tab shows every configured watcher, runnable or not** — `start()`/`reconcile()`
  create entries for `cfg.disabled` too (`entryFromDisabled`: `paused` when just `enabled:false`,
  else `disabled` + reason). Config-only card data (rule count; a schedule watcher's
  prompt/interval, which never reach the poll loop) comes from the module-level `configMeta` map:
  **call `noteConfigMeta(cfg)` at every site that re-reads config** (`start`, `reconcile`,
  `resume`, `startAll`) — never from `getStatus`, which runs on every SSE tick. The editor dialog
  sets `watchEditOpen` so the SSE re-render can't rebuild the form mid-edit, and its patch omits
  `enabled` so editing a paused watcher leaves it paused.
- **Watcher edits are merge-don't-replace, validated before the write, and reconciled live.**
  `config.saveWatcher` patches only editor-owned keys (`name`/`enabled`/`trigger`/`rules`/
  `prompt`/`poll`/`action`, nested blocks merged shallowly) so hand-written extras and `//`
  comments survive; it normalizes the merged watcher **as if enabled** and refuses to write one
  that couldn't run (the UI gets the fail-closed reason — a rejected save doesn't even create the
  `.bak`); an editor save *does* upgrade the file to v2 while `setEnabled` (pause/resume)
  deliberately does not. `watchers.upsertWatcher`/`removeWatcher` then call `reconcile(name)`,
  which re-reads config and syncs **only that watcher's** Map entry (running / paused /
  disabled+reason / gone) — never restart the whole loop for an edit. Cursors in
  `watchers-state.json` are keyed by watcher name and are NOT dropped on delete/rename, so
  re-creating a name resumes from where it left off. `/api/watchers/:name` is matched last and
  guarded by `RESERVED_WATCHER_PATHS` so `config`/`bots`/`channels`/`stop-all`/`start-all` can
  never be read as a watcher name.
- **Watcher token via a reference only** — `watchers.json` stores `slack.bots.<ref>.token` as
  `"$SLACK_BOT_TOKEN"` / `"keychain:<service>"` / `"@/path"`, resolved at load;
  never write a real `xoxb-` token into config or the repo. The launchd agent
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
- **`excludeChannels` and `paused` are two different things — keep them that way.** `paused` is a
  temporary operational toggle living in `watchers-state.json`; `trigger.excludeChannels` is durable
  policy in `watchers.json` (survives a state reset, is what an editor save writes). `runWatcherOnce`
  skips `excluded ∪ paused`, and `getStatus` reports both flags per channel so a row can say *why*
  it isn't scanning — collapse them into one and that answer is gone. Only exclusion calls
  `state.clearChannelTracking` (threads + that channel's seen-markers): a channel nobody scans must
  not keep occupying the tracked-thread budget, which is the entire point when a busy alert channel
  is the thing being muted. Both leave `cursor`/`since` alone, so either one resuming backfills the
  gap. The clear runs **lazily in the tick**, not at save time, so it also covers a hand-edited
  config and a channel excluded while the watcher was stopped. Exclusions are ids (a rename must not
  re-enable one) and are **never** reconciled against discovery — an id for a channel the bot has
  left stays excluded, so re-inviting the bot can't quietly resume it. When events land (proposals.md
  §8) exclusion must gate **event handling** too, or muted channels start producing candidates again.
- **Watcher `offline` ≠ `error` — don't collapse them.** A sleeping laptop's DarkWake windows
  produce transient DNS/socket failures every few polls; `tick` classifies those
  (`isTransientError`) as amber `offline`, escalating to red `error` only after
  `OFFLINE_ESCALATE_AFTER` consecutive failures, while auth/scope/config failures go red at
  once. Recovery clears `lastError` but keeps `lastErrorAt`/`lastErrorTransient` — a flap that
  healed before anyone looked must stay explainable. When adding a new failure path, route the
  message through the same classification rather than setting `state='error'` directly.
- **CSS colors: only use vars that are actually defined.** `--busy-text` and `--busy-badge-bg`
  do NOT exist (an undefined var silently falls back, rendering grey — this bit the "Running"
  badge and poll-age). The defined green tokens are `--busy` (vivid), `--green-text` (soft),
  `--green-badge-bg`, `--busy-glow`. Grep the `:root` block before using a color var.

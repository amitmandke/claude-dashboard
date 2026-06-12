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
`<cwd>/.claude/skills|commands` (skill picker) — and pushes snapshots to a vanilla
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
  `terminals/` = dispatcher + procEnv + iterm + appleTerminal + tmux), `utils/fsio.js`
- `web/public/` — `index.html`, `app.js`, `md.js` (minimal markdown renderer for the
  full-reply popup), `style.css` (no framework, no build step)
- `scripts/start.sh` — background-start + open browser; `install-launchd.sh` /
  `uninstall-launchd.sh` — run as a launchd user agent (login start, crash restart)
- `DESIGN.md` — full design: mockups, status→visual mapping, API contract, trade-offs
- `README.md` (user-facing, includes platform-support matrix) · `LICENSE` (MIT)

## Run / verify

```bash
node server/src/index.js          # foreground; http://localhost:7777
curl -s localhost:7777/api/sessions | python3 -m json.tool   # quick sanity check
```

No tests yet. Verify changes by running the server with real live sessions (start
`claude` somewhere) and watching the dashboard.

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
- Quick actions assume the standard permission dialog (1=Yes, 2=Yes always, Esc=No).
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

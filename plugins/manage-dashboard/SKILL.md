---
name: manage-dashboard
description: Use when running or troubleshooting a Claude Dashboard install — "is my dashboard healthy", "why did the watcher stop", "deploy the dashboard", "restart it", "it's not picking up my change", "set up the Slack/GitHub watcher", "clear these candidates", "the dashboard is slow/unresponsive", or reading ~/Library/Logs/claude-dashboard.log. For changing the dashboard's code, use develop-dashboard instead.
---

# Manage a Claude Dashboard install

You are operating a **running install**, not editing it. Everything here is service
lifecycle, configuration and diagnosis. If the fix turns out to need a code change,
say so and switch to the `develop-dashboard` skill.

## Fixed facts about any install

| | |
|---|---|
| URL | `http://localhost:7777` (override with `PORT`) — localhost only, by design |
| launchd label | `com.claude-dashboard` |
| log | `~/Library/Logs/claude-dashboard.log` (only written under launchd) |
| data dir | `~/.claude-dashboard/` — `watchers.json`, `watchers-state.json`, `candidates.json`, `titles.json`, `ai-titles.json` |
| deployed checkout | conventionally `~/.claude-dashboard/app` — the copy launchd runs |
| dependencies | none; Node ≥ 18 |

The dashboard **reads** Claude Code's own state (`~/.claude/sessions/*.json`,
`~/.claude/projects/*/*.jsonl`, `~/.claude/history.jsonl`). It never writes there.

## Step 1 — always start with the health report

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh              # read-only, changes nothing
${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh --log-lines 20
```

It answers, in order: is the server responding, is launchd running it, **which
checkout** it is running and whether that is current, watcher health, candidate
counts, data-dir contents, and the log's error profile **grouped by signature**
(one stuck thread retrying every poll writes thousands of identical lines — a plain
`tail` shows only those and hides everything else).

Read its output before proposing anything. Most reports of "my change didn't take
effect" are answered by the `running from:` line alone.

## Step 2 — the two questions that explain most complaints

**"My change isn't showing up."** The agent runs the *deployed* checkout, not your
working tree. Only merged `main` reaches it, and only via a deploy:

```bash
~/.claude-dashboard/app/scripts/deploy.sh     # fast-forwards to origin/main + restarts
```

`deploy.sh` does `git reset --hard origin/main` — it **discards local changes in the
deployed checkout**. That is intended (that copy is not for editing), but check
`doctor.sh` for the "deployed checkout has N local change(s)" warning first and ask
before throwing anything away. Static assets are served `no-cache`, so a plain
browser refresh picks up UI changes with no restart.

**"It stopped / it's not running."** Restart, don't reinstall:

```bash
launchctl kickstart -k gui/$(id -u)/com.claude-dashboard
```

## Service lifecycle

Run the installer **from the checkout you want it to run** — the plist embeds that
path and the `node` binary path, so re-run it after moving the repo or upgrading Node:

```bash
cd ~/.claude-dashboard/app && ./scripts/install-launchd.sh    # install / re-point
./scripts/uninstall-launchd.sh                                # stop and remove
./scripts/start.sh                                            # ad-hoc: start + open browser
PORT=7788 node server/src/index.js                            # throwaway instance, another port
```

**`launchctl bootout` alone does NOT restart it** despite `KeepAlive` — `bootstrap`
can leave it `not running`. Always finish with `kickstart -k`.

## Watchers

Watchers turn Slack mentions and GitHub review requests into *candidates* — proposed
sessions that only run when the user clicks. They are **off** until
`~/.claude-dashboard/watchers.json` exists; copy `watchers.example.json` (placeholders
only) and fill it in. Inspect and control them live:

```bash
curl -s localhost:7777/api/watchers | python3 -m json.tool     # status per watcher
curl -s localhost:7777/api/watchers/config | python3 -m json.tool
curl -s -X POST localhost:7777/api/watchers/<name>/pause       # also /resume, /run
curl -s -X POST localhost:7777/api/watchers/<name>/channel/pause \
  -H 'Content-Type: application/json' -d '{"channel":"C0123456"}'   # mute one noisy channel
curl -s -X POST localhost:7777/api/watchers/start-all          # also /stop-all
```

Health states are deliberately distinct: **`offline`** (amber) is a transient network
fault — a sleeping laptop's DarkWake produces these — and **`error`** (red) is
auth/config, which needs you. Offline escalates to error after 5 consecutive
failures, and recovery keeps `lastErrorAt` so the history stays readable.

**Never hand-edit `watchers-state.json` while the agent is running.** `state.js` holds
it in memory and rewrites it wholesale each tick, so your edit is clobbered within
~2 minutes. Sequence:

```bash
launchctl bootout gui/$(id -u)/com.claude-dashboard   # 1. stop (does NOT restart)
# 2. edit ~/.claude-dashboard/watchers-state.json
launchctl kickstart -k gui/$(id -u)/com.claude-dashboard   # 3. start again
```

Secrets belong in `watchers.json` as a `@file:` or keychain reference, never inline in
a commit. `watchers.json` and everything in the data dir stay out of git.

## Candidates from the shell

```bash
curl -s localhost:7777/api/candidates | python3 -m json.tool
curl -s -X POST localhost:7777/api/candidates -H 'Content-Type: application/json' \
  -d '{"cwd":"/path/to/repo","prompt":"…","skill":"review-java-service","priority":2}'
curl -s -X POST localhost:7777/api/candidates/<id>/launch     # also /dismiss, /undismiss
curl -s -X POST localhost:7777/api/candidates/bulk -H 'Content-Type: application/json' \
  -d '{"action":"dismiss","ids":["cand_a","cand_b"]}'          # or "clear"
```

`dismiss` is reversible and keeps the card as history; **`clear` is a hard delete**.
Before clearing anything you did not just create, save the records first —
`curl -s localhost:7777/api/candidates > /tmp/candidates-backup.json` — and tell the
user what went. `dismiss` only applies to pending candidates; the response reports
what it skipped, so surface that ("dismissed 11 · 1 had already been launched")
rather than a blanket success.

Retention differs by outcome: launched candidates prune after
`CLAUDE_DASH_LAUNCHED_RETENTION_HOURS` (2), dismissed after
`CLAUDE_DASH_RETENTION_DAYS` (7); **pending never prunes**, which is why a stale
pending card needs an explicit action.

## Reading the log

```bash
tail -f ~/Library/Logs/claude-dashboard.log
grep ' ERROR ' ~/Library/Logs/claude-dashboard.log | tail -30
grep 'ACTION watcher ' ~/Library/Logs/claude-dashboard.log | tail -20
```

Every mutating request logs an `ACTION` line and every failure an `ERROR` line. A
watcher pass logs one summary: `queue=… eligible=… staged=… suppressed=… settled=…
retired=…`. `tick-skipped` means the previous pass was still running — occasional is
fine, *every* tick means the interval is shorter than the work and the watcher never
rests.

## Fault table

| Symptom | Cause | Fix |
|---|---|---|
| Change not live | agent runs the deployed checkout | `~/.claude-dashboard/app/scripts/deploy.sh` |
| Nothing on the page, "reconnecting…" | server down or SSE dropped | `doctor.sh`, then `kickstart -k` |
| Watcher `error` (red) | token/scope/config | `curl /api/watchers`, read `lastError`, fix `watchers.json` |
| Watcher `offline` (amber) | transient network / laptop slept | ignore unless it escalates |
| Same ERROR every poll forever | a dead Slack thread still in the registry, or a repo you lost access to | it self-limits, but report it — the retry is wasted budget |
| Cards missing AI titles | headless `claude` not resolvable | check for `spawn claude ENOENT` in the log |
| Approve/Deny does nothing | unsupported terminal (observe-only) | check the platform matrix in `README.md` |
| Slow / unresponsive with several busy sessions | AppleEvent saturation of iTerm2 from `/screen` polling | known; a code fix, not a config one — see `develop-dashboard` |
| Editing `watchers-state.json` has no effect | the agent rewrites it every tick | bootout → edit → kickstart |

## Rules

- **Read-only first.** `doctor.sh`, `curl`, `tail` before any change.
- **Never restart or deploy without saying so** — a restart drops SSE connections and
  the user may be mid-approval on a flashing card.
- **Never end or spawn sessions to test something** without asking first; those are
  the user's real working sessions.
- Don't screenshot the live dashboard with headless Chrome — it collides with the
  user's running Chrome. Verify with `curl` against the API instead.

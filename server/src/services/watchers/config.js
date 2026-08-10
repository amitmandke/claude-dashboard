'use strict';

/**
 * Watcher configuration — loaded from ~/.claude-dashboard/watchers.json (local,
 * git-ignored; the repo ships only a documented example). A watcher is one
 * thing: a TRIGGER that produces candidates. Two trigger types exist:
 *
 *   - `slack`    — poll a bot's channels; a message matching a rule stages a
 *                  candidate. (Implemented; this is the shipped pipeline.)
 *   - `schedule` — run a saved prompt as an ephemeral session that finds work
 *                  and stages candidates. (Schema + validation only so far; the
 *                  runner does not execute these yet — see `normalize`.)
 *
 * Validation is FAIL-CLOSED: a slack watcher with no channels or no mention
 * users does not run (there is no "watch everything" wildcard), a schedule
 * watcher with no prompt does not run, and a missing/unreadable file simply
 * means the feature is off. Nothing here can spawn or post.
 *
 * SCHEMA v2 (`version: 2`) — the file shape:
 *   {
 *     "version": 2,
 *     "slack": {
 *       "bots": {
 *         "default": { "token": "$SLACK_BOT_TOKEN", "label": "dashboard-bot" }
 *       }
 *     },
 *     "watchers": [{
 *       "name": "mentions",
 *       "enabled": true,
 *       "trigger": {
 *         "type": "slack",
 *         "botRef": "default",
 *         "channels": ["C0123ABCD"],          // or "auto" to discover
 *         "mentions": ["U0456EFGH"]
 *       },
 *       "rules": [
 *         { "name": "pr-review", "about": "asked to review a PR",
 *           "action": { "type": "skill", "skill": "review-java" } },
 *         { "name": "triage", "about": "an incident to look at",
 *           "action": { "type": "prompt", "prompt": "Summarize and stage…" } }
 *       ],
 *       "poll": { "everySeconds": 120 },
 *       "action": { "preferCheckout": "acme", "cwd": "/repos/scratch" }
 *     }, {
 *       "name": "morning-pr-sweep",
 *       "enabled": true,
 *       "trigger": { "type": "schedule", "everyMinutes": 1440, "at": "09:00" },
 *       "prompt": "Check my review-requested PRs; stage a candidate for each…",
 *       "skill": "review-service",          // optional: run the prompt as /<skill>
 *       "action": { "preferCheckout": "acme", "cwd": "/repos" }
 *     }]
 *   }
 *
 * `rules` is the when→then map: the classifier matches a qualifying thread to
 * ONE named rule (or none) and the action comes from the rule, not from the
 * model — that is the "explicit control" over what launches. With no rules, the
 * classifier picks a skill freely from the catalog (looser, less controlled).
 *
 * v1 → v2 MIGRATION happens at load time, in memory, and is idempotent
 * (`migrateRaw`): the on-disk file is never rewritten just to upgrade it, so a
 * v1 file keeps working untouched and every entry point below accepts either
 * shape. The transform is mechanical and lossless:
 *   slack.botToken            → slack.bots.default.token (+ trigger.botRef "default")
 *   trigger.type "mention"    → "slack"
 *   trigger.users / mentionUsers / users → trigger.mentions
 *   watcher.channels          → trigger.channels
 *   intents[{name,description,skill}] → rules[{name, about, action:{type:"skill",skill}}]
 *
 * Normalized watchers also carry BACK-COMPAT ALIASES for the shipped runner,
 * which still speaks v1 internally: `mentionUsers`, `trigger.users`, and
 * `intents` (derived from `rules`). Those are the seam to delete once
 * `watchers/index.js` and `classify.js` read `rules`/`mentions` directly.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const config = require('../../config');
const { writeJsonAtomic } = require('../../utils/fsio');

const FILE = path.join(config.DATA_DIR, 'watchers.json');
const MIN_POLL_SECONDS = 30;
const SCHEMA_VERSION = 2;
/**
 * Trigger types the schema knows. `slack` and `github` are executed; `schedule`
 * validates but has no runner yet, so it lands in `disabled` with that reason
 * rather than silently vanishing.
 */
const SUPPORTED_TRIGGERS = ['slack', 'schedule', 'github'];
/** v1 trigger names → v2. `dm` is gone for good (it needed ungrantable scopes). */
const TRIGGER_ALIASES = { mention: 'slack' };
const RULE_ACTIONS = ['skill', 'prompt'];
const DEFAULT_BOT_REF = 'default';
const DAILY_MINUTES = 1440;

/** Skill names are bare command words; empty is allowed (no skill). */
function isValidSkillName(skill) {
  return !skill || /^[\w:-]+$/.test(skill);
}

/**
 * Resolve a token reference to the secret string. Schemes, most→least secure:
 *   "keychain:<service>[:<account>]" — read from the macOS Keychain via the
 *       built-in `security` CLI (encrypted at rest; never enters process.env, so
 *       it is not inherited by the headless `claude -p` children we spawn).
 *   "@/abs/path"                     — read from a file (keep it `chmod 600`).
 *   "$ENV_VAR"                       — read from the environment.
 *   "<literal>"                      — the token inline (discouraged).
 * Returns null on any failure so the watcher fails closed (logged, never runs
 * with a bad token). `io` is injectable for tests (no real Keychain/fs).
 */
function resolveToken(value, env = process.env, io = {}) {
  if (typeof value !== 'string' || !value) return null;
  const readFile = io.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const readKeychain =
    io.readKeychain ||
    ((service, account) =>
      execFileSync(
        'security',
        ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'],
        { encoding: 'utf8' }
      ));
  try {
    if (value.startsWith('keychain:')) {
      const [service, account] = value.slice('keychain:'.length).split(':');
      if (!service) return null;
      return readKeychain(service, account).trim() || null;
    }
    if (value.startsWith('@')) {
      return readFile(value.slice(1)).trim() || null;
    }
    if (value.startsWith('$')) {
      return env[value.slice(1)] || null;
    }
    return value;
  } catch {
    return null; // missing keychain item / unreadable file → fail closed
  }
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim());
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ---- v1 → v2 migration (pure, idempotent, never touches disk) --------------

/** One v1 intent → one v2 rule. Unknown keys ride along untouched. */
function intentToRule(intent) {
  if (!isPlainObject(intent)) return null;
  const rule = { ...intent };
  if (rule.about === undefined && typeof rule.description === 'string') rule.about = rule.description;
  delete rule.description;
  // A v1 intent's only action was "use this skill" (possibly empty).
  if (!isPlainObject(rule.action) && rule.skill !== undefined) {
    rule.action = { type: 'skill', skill: rule.skill };
  }
  delete rule.skill;
  return rule;
}

/**
 * Upgrade one raw watcher to v2 in memory. Idempotent: a v2 watcher comes back
 * unchanged. Does not mutate the input (blocks we don't touch are shared by
 * reference, and nothing here writes through them).
 */
function migrateWatcherRaw(raw) {
  if (!isPlainObject(raw)) return raw;
  const out = { ...raw };
  const t = isPlainObject(out.trigger) ? { ...out.trigger } : {};

  let type = typeof t.type === 'string' ? t.type.trim() : '';
  if (TRIGGER_ALIASES[type]) type = TRIGGER_ALIASES[type];
  if (!type) type = 'slack'; // v1 files often had no trigger block at all
  t.type = type;

  if (type === 'slack') {
    // mentions: prefer the v2 field, else fold in every v1 spelling
    t.mentions = [
      ...new Set(
        asArray(t.mentions).concat(asArray(t.users), asArray(out.mentionUsers), asArray(out.users))
      ),
    ];
    if (t.channels === undefined && out.channels !== undefined) t.channels = out.channels;
    if (!(typeof t.botRef === 'string' && t.botRef.trim())) t.botRef = DEFAULT_BOT_REF;
    delete t.users;
    delete out.mentionUsers;
    delete out.users;
    delete out.channels;
  }
  out.trigger = t;

  if (!Array.isArray(out.rules) && Array.isArray(out.intents)) {
    out.rules = out.intents.map(intentToRule).filter(Boolean);
  }
  delete out.intents;
  return out;
}

/**
 * Upgrade the whole raw file to v2 in memory. Idempotent; preserves unknown
 * keys (including the `//`-prefixed comments the example file uses) so this can
 * also back a round-trip "merge, don't replace" save later.
 */
function migrateRaw(raw) {
  if (!isPlainObject(raw)) return raw;
  const out = { version: SCHEMA_VERSION, ...raw }; // `version` first, for a human reading the file
  out.version = SCHEMA_VERSION;
  if (isPlainObject(raw.slack)) {
    const slack = { ...raw.slack };
    const bots = isPlainObject(slack.bots) ? { ...slack.bots } : {};
    if (slack.botToken !== undefined) {
      if (bots[DEFAULT_BOT_REF] === undefined) bots[DEFAULT_BOT_REF] = { token: slack.botToken };
      delete slack.botToken;
    }
    if (Object.keys(bots).length) slack.bots = bots;
    out.slack = slack;
  }
  if (Array.isArray(raw.watchers)) out.watchers = raw.watchers.map(migrateWatcherRaw);
  return out;
}

// ---- normalization (raw of either version → runnable shape) ----------------

/**
 * Normalize `slack.bots` into `{ ref: { ref, label, tokenRef, token } }`.
 * `token` is the RESOLVED secret (null when it can't be read → fail closed);
 * `tokenRef` is the safe-to-display reference (e.g. "keychain:dash-slack").
 * Refs are identifier-ish so they can be used in URLs/config without quoting.
 */
function normalizeBots(raw, env = process.env, io = {}) {
  const r = migrateRaw(raw);
  const src = isPlainObject(r) && isPlainObject(r.slack) && isPlainObject(r.slack.bots) ? r.slack.bots : {};
  const bots = {};
  for (const [key, value] of Object.entries(src)) {
    const ref = typeof key === 'string' ? key.trim() : '';
    if (!ref || !/^[\w.-]+$/.test(ref)) continue;
    const spec = typeof value === 'string' ? { token: value } : value;
    if (!isPlainObject(spec)) continue;
    const tokenRef = typeof spec.token === 'string' ? spec.token.trim() : '';
    bots[ref] = {
      ref,
      label: typeof spec.label === 'string' ? spec.label.trim() : '',
      tokenRef,
      token: resolveToken(tokenRef, env, io),
    };
  }
  return bots;
}

/**
 * Normalize a `github` trigger → the review-queue producer's settings.
 *
 * There is no token here on purpose: this speaks through the user's own `gh` CLI
 * login, so there is no secret to store and nothing new to reference. Defaults
 * are the ones validated against the real 48-PR queue: bots out (including plain
 * `dependabot`, which carries no `[bot]` suffix), drafts out, stories capped, and
 * a per-tick stage cap so a first run fills gradually instead of dumping ~30
 * candidates at once.
 */
function normalizeGithubTrigger(t) {
  const search =
    typeof t.search === 'string' && t.search.trim()
      ? t.search.trim()
      : 'review-requested:@me is:open is:pr';
  const login = typeof t.login === 'string' ? t.login.trim() : '';
  const projects = asArray(t.jiraProjects).map((p) => p.toUpperCase());
  const excludeAuthors = asArray(t.excludeAuthors);
  const includeAuthors = asArray(t.includeAuthors);
  if (excludeAuthors.length && includeAuthors.length) {
    return { error: 'github trigger cannot set both includeAuthors and excludeAuthors' };
  }
  const first = parseInt(t.first, 10);
  const maxGroupSize = parseInt(t.maxGroupSize, 10);
  const maxStagePerTick = parseInt(t.maxStagePerTick, 10);
  return {
    type: 'github',
    search,
    login,
    projects,
    excludeAuthors,
    includeAuthors,
    skipDrafts: t.skipDrafts === undefined ? true : !!t.skipDrafts,
    first: Number.isFinite(first) && first > 0 ? Math.min(first, 100) : 50,
    maxGroupSize: Number.isFinite(maxGroupSize) && maxGroupSize > 0 ? maxGroupSize : 5,
    maxStagePerTick: Number.isFinite(maxStagePerTick) && maxStagePerTick > 0 ? maxStagePerTick : 5,
  };
}

/**
 * Normalize a `schedule` trigger → `{ type, everyMinutes, at, cron }` or
 * `{ error }`. One of everyMinutes / at / cron is required; `at` alone means
 * daily. Nothing here schedules anything — the runner ignores these for now.
 */
function normalizeScheduleTrigger(t) {
  const cron = typeof t.cron === 'string' ? t.cron.trim() : '';
  const rawAt = typeof t.at === 'string' ? t.at.trim() : '';
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(rawAt) ? rawAt : '';
  if (rawAt && !at) return { error: `invalid schedule time "${rawAt}" (want HH:MM)` };
  const n = parseInt(t.everyMinutes, 10);
  const everyMinutes = Number.isFinite(n) && n > 0 ? n : 0;
  if (!everyMinutes && !at && !cron) {
    return { error: 'schedule trigger needs everyMinutes, at, or cron' };
  }
  return { type: 'schedule', everyMinutes: everyMinutes || (at ? DAILY_MINUTES : 0), at, cron };
}

/**
 * Normalize the `trigger` block of a raw watcher (either schema version — the
 * v1 fallbacks are handled by `migrateWatcherRaw`). Returns the trigger or
 * `{ error }` when it can't run (fail-closed).
 *
 *  - `slack`: qualify a channel thread when one of `mentions` is @-mentioned.
 *    Requires a non-empty `mentions` allowlist. `channels: "auto"` discovers
 *    every channel the bot is a member of. `users` is a v1 alias of `mentions`.
 *  - `schedule`: fire on an interval / daily time / cron.
 */
function normalizeTrigger(raw) {
  const w = migrateWatcherRaw(raw);
  const t = (isPlainObject(w) && w.trigger) || {};
  const type = t.type;
  if (!SUPPORTED_TRIGGERS.includes(type)) return { error: `unsupported trigger type "${type}"` };
  if (type === 'schedule') return normalizeScheduleTrigger(t);
  if (type === 'github') return normalizeGithubTrigger(t);

  const mentions = asArray(t.mentions);
  if (mentions.length === 0) return { error: 'slack trigger has no mention users (fail-closed)' };
  // `channels: "auto"` = discover every channel the bot is a member of (via
  // users.conversations) and scan them all; an explicit array watches just
  // those. An empty array stays fail-closed (watches nothing).
  const discover = typeof t.channels === 'string' && t.channels.trim().toLowerCase() === 'auto';
  const channels = discover ? [] : [...new Set(asArray(t.channels))];
  // `excludeChannels` is the denylist that makes `auto` usable: keep discovering
  // every channel the bot joins, but never scan these. Stored as ids (a rename
  // must not silently re-enable one) and deliberately NOT reconciled against the
  // discovered list — an id for a channel the bot has left stays excluded, so
  // re-inviting the bot doesn't quietly resume a channel that was muted on purpose.
  const excludeChannels = [...new Set(asArray(t.excludeChannels))];
  const botRef = typeof t.botRef === 'string' && t.botRef.trim() ? t.botRef.trim() : DEFAULT_BOT_REF;
  return { type, botRef, mentions, users: mentions, channels, discover, excludeChannels };
}

/**
 * Normalize the when→then rules; drops malformed entries. May be empty (that is
 * "free mode": the classifier picks a skill from the catalog itself).
 */
function normalizeRules(raw) {
  const w = migrateWatcherRaw(raw);
  const list = (isPlainObject(w) && Array.isArray(w.rules) && w.rules) || [];
  const out = [];
  for (const r of list) {
    if (!isPlainObject(r)) continue;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) continue;
    const a = isPlainObject(r.action) ? r.action : {};
    const type = (typeof a.type === 'string' && a.type.trim()) || 'skill';
    if (!RULE_ACTIONS.includes(type)) continue;
    const about = typeof r.about === 'string' ? r.about.trim() : '';
    if (type === 'prompt') {
      const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
      if (!prompt) continue;
      out.push({ name, about, action: { type, prompt } });
      continue;
    }
    const skill = typeof a.skill === 'string' ? a.skill.trim() : '';
    if (!isValidSkillName(skill)) continue;
    out.push({ name, about, action: { type, skill } });
  }
  return out;
}

/**
 * v1 view of `rules`, for the runner + classifier, which still speak
 * intent->skill. A `prompt` rule maps to an empty skill (the runner can't run a
 * rule prompt yet; `rules` carries the truth). Exported for tests.
 */
function rulesToIntents(rules) {
  return rules.map((r) => ({
    name: r.name,
    description: r.about,
    skill: r.action.type === 'skill' ? r.action.skill : '',
  }));
}

/** Legacy entry point: normalize raw intents/rules into the v1 intent shape. */
function normalizeIntents(raw) {
  return rulesToIntents(normalizeRules(raw));
}

/**
 * Normalize + validate one raw watcher (either schema version) into a runnable
 * shape, or return `{ ok:false, reason }` when it must be disabled. Pure —
 * unit-testable.
 */
function normalizeWatcher(raw, i) {
  const w = migrateWatcherRaw(raw);
  const name = (isPlainObject(w) && typeof w.name === 'string' && w.name.trim()) || `watcher-${i + 1}`;
  const declaredType = (isPlainObject(w) && w.trigger && w.trigger.type) || 'slack';
  if (!isPlainObject(w) || w.enabled === false) {
    return { ok: false, name, type: declaredType, reason: 'disabled' };
  }

  const trigger = normalizeTrigger(w);
  if (trigger.error) return { ok: false, name, type: declaredType, reason: trigger.error };

  const rules = normalizeRules(w);
  const action = isPlainObject(w.action) ? w.action : {};
  const base = {
    ok: true,
    name,
    type: trigger.type,
    trigger,
    rules,
    intents: rulesToIntents(rules), // v1 alias for the runner/classifier
    preferCheckout: typeof action.preferCheckout === 'string' ? action.preferCheckout : null,
    // fallback target folder when no PR/repo can be resolved from the message,
    // so a produced candidate is always launchable.
    defaultCwd: typeof action.cwd === 'string' ? action.cwd.trim() : '',
  };

  if (trigger.type === 'schedule') {
    const prompt = typeof w.prompt === 'string' ? w.prompt.trim() : '';
    if (!prompt) return { ok: false, name, type: trigger.type, reason: 'schedule watcher has no prompt (fail-closed)' };
    // optional skill the producer session runs the prompt under (`/<skill> <prompt>`)
    const skill = typeof w.skill === 'string' ? w.skill.trim() : '';
    if (!isValidSkillName(skill)) {
      return { ok: false, name, type: trigger.type, reason: `invalid skill name "${skill}"` };
    }
    return {
      ...base,
      prompt,
      skill,
      everyMinutes: trigger.everyMinutes,
      at: trigger.at,
      cron: trigger.cron,
    };
  }

  if (trigger.type === 'github') {
    // The review queue changes on human timescales and costs one API call, so it
    // polls far less often than a Slack channel; 15 minutes by default.
    const everySeconds = Math.max(
      MIN_POLL_SECONDS,
      parseInt((w.poll && w.poll.everySeconds) || 900, 10) || 900
    );
    const template = typeof w.prompt === 'string' && w.prompt.trim() ? w.prompt : '';
    // A `rules` entry maps a detected stack to a review skill: name the rule after
    // the stack (`go`, `java`) so the mapping stays visible and editable in config
    // instead of hiding in code.
    const skillsByStack = {};
    for (const r of rules) {
      if (r.action.type === 'skill' && r.action.skill) skillsByStack[r.name.toLowerCase()] = r.action.skill;
    }
    return { ...base, ...trigger, everySeconds, template, skillsByStack };
  }

  if (!trigger.discover && trigger.channels.length === 0) {
    return { ok: false, name, type: trigger.type, reason: 'no channels (fail-closed)' };
  }
  // an explicit list fully covered by the denylist watches nothing — fail closed
  // rather than run a watcher that can never produce a candidate.
  if (
    !trigger.discover &&
    trigger.channels.every((c) => trigger.excludeChannels.includes(c))
  ) {
    return { ok: false, name, type: trigger.type, reason: 'every channel is excluded (fail-closed)' };
  }
  const everySeconds = Math.max(
    MIN_POLL_SECONDS,
    parseInt((w.poll && w.poll.everySeconds) || 120, 10) || 120
  );
  return {
    ...base,
    botRef: trigger.botRef,
    channels: trigger.channels,
    discover: trigger.discover,
    excludeChannels: trigger.excludeChannels,
    mentionUsers: trigger.mentions, // convenience alias for the mention pipeline
    everySeconds,
  };
}

/**
 * Normalize the whole file (either schema version) into
 * `{ version, bots, token, watchers, disabled, all }`. Pure over `raw`.
 *
 *  - `watchers` — RUNNABLE slack watchers only, each with its bot's resolved
 *    `token`. The Slack poll loop consumes exactly this list, so a trigger type
 *    it can't execute can never reach it.
 *  - `disabled` — `{ name, reason }` for everything that won't run, including
 *    valid `schedule` watchers (reason: not implemented yet) so they surface
 *    honestly instead of silently vanishing.
 *  - `all` — every normalized watcher regardless of runnability, for the
 *    management UI/API.
 *  - `token` — the default bot's resolved token (v1 alias, single-bot callers).
 */
function normalize(raw, env = process.env, io = {}) {
  const r = migrateRaw(raw);
  const bots = normalizeBots(r, env, io);
  const defaultBot = bots[DEFAULT_BOT_REF] || Object.values(bots)[0] || null;
  const list = (isPlainObject(r) && Array.isArray(r.watchers) && r.watchers) || [];
  const watchers = [];
  const githubWatchers = [];
  const disabled = [];
  const all = [];
  list.forEach((w, i) => {
    const n = normalizeWatcher(w, i);
    if (n.ok && n.type === 'slack') {
      const bot = bots[n.botRef] || null;
      n.token = bot ? bot.token : null;
      n.botLabel = bot ? bot.label : '';
      watchers.push(n);
    } else if (n.ok && n.type === 'github') {
      githubWatchers.push(n);
    } else if (n.ok) {
      disabled.push({ name: n.name, reason: `${n.type} watcher not implemented yet` });
    } else {
      disabled.push({ name: n.name, reason: n.reason });
    }
    all.push(n);
  });
  return {
    version: SCHEMA_VERSION,
    bots,
    token: defaultBot ? defaultBot.token : null,
    watchers,
    githubWatchers,
    disabled,
    all,
  };
}

/**
 * Read + normalize the config file. Returns an empty (off) config when absent.
 * `fileVersion` is what was actually on disk (1 for a pre-v2 file) — the file
 * itself is never rewritten to upgrade it; migration is in-memory only.
 */
function load(file = FILE, env = process.env, io = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: SCHEMA_VERSION, fileVersion: 0, bots: {}, token: null, watchers: [], githubWatchers: [], disabled: [], all: [], present: false };
  }
  const onDisk = parseInt(isPlainObject(raw) && raw.version, 10);
  return {
    ...normalize(raw, env, io),
    fileVersion: Number.isFinite(onDisk) && onDisk > 0 ? onDisk : 1,
    present: true,
  };
}

/**
 * Copy `watchers.json` to `watchers.json.bak` once, before the first rewrite
 * this install ever does. Cheap insurance for a hand-written config (an earlier
 * file-loss scare is exactly why every write path calls this). Fail-soft: a
 * failed copy never blocks the write — the original is still intact on disk.
 */
function backupOnce(file = FILE) {
  const bak = `${file}.bak`;
  try {
    if (fs.existsSync(bak)) return true; // the pre-first-rewrite copy already exists
    if (!fs.existsSync(file)) return false;
    fs.copyFileSync(file, bak);
    return true;
  } catch {
    return false;
  }
}

/** Derive a raw watcher's name exactly as `normalizeWatcher` does. */
function rawWatcherName(w, i) {
  return (isPlainObject(w) && typeof w.name === 'string' && w.name.trim()) || `watcher-${i + 1}`;
}

/**
 * The watcher keys an editor owns. A save patches ONLY these and leaves
 * everything else on the stored watcher untouched (merge, don't replace), so
 * hand-written extras and `//` comments survive a round trip through the UI.
 * The nested blocks merge shallowly for the same reason — a patch of just
 * `{ trigger: { channels } }` keeps the existing mentions/botRef.
 */
const WATCHER_KEYS = ['name', 'enabled', 'trigger', 'rules', 'prompt', 'skill', 'poll', 'action'];
const MERGE_BLOCKS = ['trigger', 'poll', 'action'];
const WATCHER_NAME_RE = /^[\w][\w .-]{0,63}$/;

/** Merge an editor patch onto a stored raw watcher. Pure. */
function mergeWatcherRaw(stored, patch) {
  const out = isPlainObject(stored) ? { ...stored } : {};
  if (!isPlainObject(patch)) return out;
  for (const key of WATCHER_KEYS) {
    if (patch[key] === undefined) continue;
    if (MERGE_BLOCKS.includes(key) && isPlainObject(out[key]) && isPlainObject(patch[key])) {
      out[key] = { ...out[key], ...patch[key] };
      continue;
    }
    out[key] = patch[key];
  }
  return out;
}

/** Read the raw file, or a fresh empty v2 skeleton when it doesn't exist yet. */
function readRawOrEmpty(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isPlainObject(raw)) return raw;
  } catch {
    /* fall through to a fresh file */
  }
  return { version: SCHEMA_VERSION, slack: { bots: {} }, watchers: [] };
}

/**
 * Create or update one watcher, patching the raw file. `name` is the watcher to
 * update (null/'' to create); `patch.name` renames it. Returns
 * `{ ok, name, created }` or `{ ok:false, error }` — nothing is written unless
 * the merged result actually normalizes to a runnable watcher, so the UI gets
 * the fail-closed reason instead of silently saving a dead watcher (an explicit
 * `enabled:false` still saves — it is validated as if enabled).
 *
 * Unlike `setEnabled`, an editor save **upgrades the file to v2** (the watcher
 * it writes is v2-shaped, so leaving a v1 `slack.botToken` beside a `botRef`
 * would be confusing to read by hand). Existing content is migrated losslessly,
 * unknown keys and comments included, then written atomically after a one-time
 * backup.
 */
function saveWatcher(name, patch, file = FILE) {
  if (!isPlainObject(patch)) return { ok: false, error: 'patch must be an object' };
  const raw = migrateRaw(readRawOrEmpty(file));
  const list = Array.isArray(raw.watchers) ? [...raw.watchers] : [];

  const target = name ? String(name).trim() : '';
  const at = target ? list.findIndex((w, i) => rawWatcherName(w, i) === target) : -1;
  if (target && at === -1) return { ok: false, error: `unknown watcher "${target}"` };

  const stored = at === -1 ? {} : list[at];
  const merged = migrateWatcherRaw(mergeWatcherRaw(stored, patch));
  const nextName = rawWatcherName(merged, at === -1 ? list.length : at);
  if (!WATCHER_NAME_RE.test(nextName)) return { ok: false, error: `invalid watcher name "${nextName}"` };
  if (list.some((w, i) => i !== at && rawWatcherName(w, i) === nextName)) {
    return { ok: false, error: `a watcher named "${nextName}" already exists` };
  }
  merged.name = nextName; // pin it, so a derived name can't drift on a later edit

  // Fail-closed at the door: validate as if enabled, whatever `enabled` says.
  const check = normalizeWatcher({ ...merged, enabled: true }, at === -1 ? list.length : at);
  if (!check.ok) return { ok: false, error: check.reason };

  if (at === -1) list.push(merged);
  else list[at] = merged;
  raw.watchers = list;

  backupOnce(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, raw);
  } catch (e) {
    return { ok: false, error: `could not write config: ${e.message}` };
  }
  return { ok: true, name: nextName, created: at === -1, renamed: !!target && nextName !== target };
}

/**
 * Remove a watcher from the raw file. Returns `{ ok, name }` or
 * `{ ok:false, error }`. Its entry in `watchers-state.json` is deliberately
 * left alone (cursors are keyed by watcher name): recreating the same name
 * resumes watching from where it left off rather than re-baselining.
 */
function deleteWatcher(name, file = FILE) {
  const target = name ? String(name).trim() : '';
  if (!target) return { ok: false, error: 'name is required' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, error: 'no config file' };
  }
  if (!isPlainObject(raw) || !Array.isArray(raw.watchers)) return { ok: false, error: 'no watchers in config' };
  const at = raw.watchers.findIndex((w, i) => rawWatcherName(w, i) === target);
  if (at === -1) return { ok: false, error: `unknown watcher "${target}"` };
  raw.watchers = raw.watchers.filter((_, i) => i !== at);
  backupOnce(file);
  try {
    writeJsonAtomic(file, raw);
  } catch (e) {
    return { ok: false, error: `could not write config: ${e.message}` };
  }
  return { ok: true, name: target };
}

/**
 * The editable config, safe to hand to a browser: every watcher in v2 raw shape
 * (what a save patches, so the UI's Raw-JSON view round-trips) plus the bot
 * list with **references only, never resolved secrets**.
 */
function editableConfig(file = FILE, env = process.env, io = {}) {
  const present = fs.existsSync(file);
  const raw = migrateRaw(readRawOrEmpty(file));
  const bots = normalizeBots(raw, env, io);
  const norm = normalize(raw, env, io);
  const byName = new Map(norm.all.map((w) => [w.name, w]));
  return {
    present,
    version: SCHEMA_VERSION,
    bots: Object.values(bots).map((b) => ({
      ref: b.ref,
      label: b.label,
      tokenRef: b.tokenRef,
      resolves: !!b.token, // whether the reference reads back a token at all
    })),
    watchers: (Array.isArray(raw.watchers) ? raw.watchers : []).map((w, i) => {
      const name = rawWatcherName(w, i);
      const n = byName.get(name);
      return {
        name,
        raw: w,
        type: n ? n.type : 'slack',
        ok: !!(n && n.ok),
        reason: n && !n.ok ? n.reason : null,
      };
    }),
  };
}

/**
 * Flip a watcher's `enabled` flag in the RAW file — preserving every other
 * field, its schema version, and unknown keys, matched by the same name
 * derivation `normalizeWatcher` uses. Writes atomically, after a one-time
 * backup. Fail-soft: returns false if the file is unreadable, has no watchers
 * array, or no watcher matches. This is how Pause/Resume survive a restart.
 * Deliberately does NOT upgrade the file's schema — it is a flag flip, not an
 * edit (an editor save is what upgrades; see `saveWatcher`).
 */
function setEnabled(name, enabled, file = FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!raw || !Array.isArray(raw.watchers)) return false;
  let hit = false;
  raw.watchers.forEach((w, i) => {
    if (!w || typeof w !== 'object') return;
    const wn = (typeof w.name === 'string' && w.name.trim()) || `watcher-${i + 1}`;
    if (wn === name) {
      w.enabled = !!enabled;
      hit = true;
    }
  });
  if (!hit) return false;
  backupOnce(file);
  try {
    writeJsonAtomic(file, raw);
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  load,
  normalize,
  normalizeBots,
  normalizeWatcher,
  normalizeTrigger,
  normalizeRules,
  normalizeIntents,
  rulesToIntents,
  migrateRaw,
  migrateWatcherRaw,
  mergeWatcherRaw,
  rawWatcherName,
  resolveToken,
  isValidSkillName,
  backupOnce,
  setEnabled,
  saveWatcher,
  deleteWatcher,
  editableConfig,
  FILE,
  MIN_POLL_SECONDS,
  SCHEMA_VERSION,
  SUPPORTED_TRIGGERS,
  RULE_ACTIONS,
  DEFAULT_BOT_REF,
};

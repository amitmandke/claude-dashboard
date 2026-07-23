'use strict';

/**
 * Watcher configuration — loaded from ~/.claude-dashboard/watchers.json (local,
 * git-ignored; the repo ships only a documented example). A watcher watches one
 * or more Slack channels for messages that @-mention specific users, and turns
 * the surrounding thread into a candidate session.
 *
 * Validation is FAIL-CLOSED: a watcher with no channels or no mention-users does
 * not run (there is no "watch everything" wildcard), and a missing/unreadable
 * file simply means the feature is off. Nothing here can spawn or post.
 *
 * File shape:
 *   {
 *     "slack": { "botToken": "$SLACK_BOT_TOKEN" },
 *     "watchers": [{
 *       "name": "mentions",
 *       "enabled": true,
 *       "channels": ["C0123ABCD"],
 *       "trigger": { "type": "mention", "users": ["U0456EFGH"] },
 *       "intents": [
 *         { "name": "pr-review", "description": "asked to review a PR", "skill": "review-java" },
 *         { "name": "bug",       "description": "a bug to investigate",  "skill": "debug" }
 *       ],
 *       "poll": { "everySeconds": 120 },
 *       "action": { "preferCheckout": "acme" }
 *     }]
 *   }
 *
 * `trigger` says what makes a thread worth looking at (only `mention` is
 * implemented; the shape leaves room for `keyword`/`reaction` later). `intents`
 * is your intent->skill map: the classifier matches a thread to ONE named intent
 * (or none) and the skill is taken from the map, not chosen by the model — that
 * is the "explicit control" over what launches. With no intents, the classifier
 * picks a skill freely from the catalog (looser, less controlled).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const config = require('../../config');

const FILE = path.join(config.DATA_DIR, 'watchers.json');
const MIN_POLL_SECONDS = 30;
const SUPPORTED_TRIGGERS = ['mention'];

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

/**
 * Normalize the `trigger` block. Falls back to a `mention` trigger built from
 * the legacy `mentionUsers`/`users` fields so old configs keep working. Returns
 * `{ type, users }` or `{ error }` when it can't run (fail-closed).
 *
 *  - `mention`: qualify a channel thread when one of `users` is @-mentioned.
 * Requires a non-empty `users` allowlist.
 */
function normalizeTrigger(raw) {
  const t = (raw && raw.trigger) || null;
  const type = (t && typeof t.type === 'string' && t.type.trim()) || 'mention';
  if (!SUPPORTED_TRIGGERS.includes(type)) return { error: `unsupported trigger type "${type}"` };
  // users may come from trigger.users or the legacy top-level fields
  const users = [
    ...new Set(asArray(t && t.users).concat(asArray(raw.mentionUsers), asArray(raw.users))),
  ];
  if (users.length === 0) return { error: `${type} trigger has no users (fail-closed)` };
  return { type, users };
}

/** Normalize the intent->skill map; drops malformed entries. May be empty. */
function normalizeIntents(raw) {
  const list = (raw && Array.isArray(raw.intents) && raw.intents) || [];
  const out = [];
  for (const it of list) {
    const name = it && typeof it.name === 'string' ? it.name.trim() : '';
    const skill = it && typeof it.skill === 'string' ? it.skill.trim() : '';
    if (!name || !isValidSkillName(skill)) continue;
    out.push({ name, description: (it.description || '').trim(), skill });
  }
  return out;
}

/**
 * Normalize + validate one raw watcher into a runnable shape, or return
 * `{ ok:false, reason }` when it must be disabled. Pure — unit-testable.
 */
function normalizeWatcher(raw, i) {
  const name = (raw && typeof raw.name === 'string' && raw.name.trim()) || `watcher-${i + 1}`;
  if (!raw || raw.enabled === false) return { ok: false, name, reason: 'disabled' };

  const trigger = normalizeTrigger(raw);
  if (trigger.error) return { ok: false, name, reason: trigger.error };

  // `channels: "auto"` = discover every channel the bot is a member of (via
  // users.conversations) and scan them all; an explicit array watches just
  // those. An empty array stays fail-closed (watches nothing).
  const discover = typeof raw.channels === 'string' && raw.channels.trim().toLowerCase() === 'auto';
  const channels = discover ? [] : asArray(raw.channels);
  if (!discover && channels.length === 0) {
    return { ok: false, name, reason: 'no channels (fail-closed)' };
  }

  const everySeconds = Math.max(
    MIN_POLL_SECONDS,
    parseInt((raw.poll && raw.poll.everySeconds) || 120, 10) || 120
  );
  const action = raw.action || {};
  return {
    ok: true,
    name,
    channels: [...new Set(channels)],
    discover,
    trigger,
    mentionUsers: trigger.users, // convenience alias for the mention pipeline
    intents: normalizeIntents(raw),
    everySeconds,
    preferCheckout: typeof action.preferCheckout === 'string' ? action.preferCheckout : null,
    // fallback target folder when no PR/repo can be resolved from the message,
    // so a produced candidate is always launchable.
    defaultCwd: typeof action.cwd === 'string' ? action.cwd.trim() : '',
  };
}

/** Normalize the whole file into `{ token, watchers, disabled }`. Pure over `raw`. */
function normalize(raw, env = process.env) {
  const token = resolveToken(raw && raw.slack && raw.slack.botToken, env);
  const list = (raw && Array.isArray(raw.watchers) && raw.watchers) || [];
  const watchers = [];
  const disabled = [];
  list.forEach((w, i) => {
    const n = normalizeWatcher(w, i);
    if (n.ok) watchers.push(n);
    else disabled.push({ name: n.name, reason: n.reason });
  });
  return { token, watchers, disabled };
}

/** Read + normalize the config file. Returns an empty (off) config when absent. */
function load(file = FILE, env = process.env) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { token: null, watchers: [], disabled: [], present: false };
  }
  return { ...normalize(raw, env), present: true };
}

/**
 * Flip a watcher's `enabled` flag in the RAW file (preserving every other field
 * and formatting-agnostic), matched by the same name derivation
 * `normalizeWatcher` uses. Fail-soft: returns false if the file is unreadable,
 * has no watchers array, or no watcher matches. This is how Pause/Resume
 * survive a restart.
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
  try {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  load,
  normalize,
  normalizeWatcher,
  normalizeTrigger,
  normalizeIntents,
  resolveToken,
  isValidSkillName,
  setEnabled,
  FILE,
  MIN_POLL_SECONDS,
  SUPPORTED_TRIGGERS,
};

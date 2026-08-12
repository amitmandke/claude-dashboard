'use strict';

/**
 * Candidate sessions — a launchable, prioritized pending list. A *candidate* is
 * a session you could launch but haven't: a concrete plan (cwd + optional skill
 * + prompt) waiting with a reason and a priority. Producers (a running session
 * via POST /api/candidates, a watcher, or the user) all converge on this one
 * list; nothing spawns until someone clicks Launch (auto-launch is a later,
 * capped opt-in). A candidate is inert data — the producer API can't make
 * anything run on its own.
 *
 * Persisted to ~/.claude-dashboard/candidates.json (our own dir; never write
 * into ~/.claude), loaded into memory and pushed over SSE — the same single-
 * file, single-writer pattern customTitles.js / aiTitles.js use. One event loop
 * means no locking; every mutation is load → mutate → atomic save.
 */

const fs = require('fs');
const path = require('path');

const config = require('../../config');
const fsio = require('../../utils/fsio');

const FILE = path.join(config.DATA_DIR, 'candidates.json');

let cache = null; // { candidates: [...] }
let counter = 0;

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = parsed && Array.isArray(parsed.candidates) ? parsed : { candidates: [] };
  } catch {
    cache = { candidates: [] };
  }
  return cache;
}

function save() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fsio.writeJsonAtomic(FILE, cache);
}

function newId() {
  counter = (counter + 1) % 1e6;
  return 'cand_' + Date.now().toString(36) + counter.toString(36);
}

// ---- pure helpers (exported for tests) ------------------------------------

const STATUS_RANK = { pending: 0, launched: 1, dismissed: 2 };

/** Skill names are bare command words; empty (no skill) is allowed. */
function isValidSkillName(skill) {
  return !skill || /^[\w:-]+$/.test(skill);
}

/**
 * Display order: pending first (higher priority first, then oldest first so a
 * backlog drains FIFO within a priority), then launched/dismissed history with
 * the most recent action first. Returns a new array; never mutates the input.
 */
function sortCandidates(list) {
  return [...list].sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.status === 'pending') {
      const pa = a.priority || 0;
      const pb = b.priority || 0;
      if (pa !== pb) return pb - pa; // higher priority launches first
      return (a.createdAt || '').localeCompare(b.createdAt || ''); // oldest first
    }
    // history: most recent state change first
    return (b.statusAt || b.createdAt || '').localeCompare(a.statusAt || a.createdAt || '');
  });
}

/**
 * Aged-out history items are prunable; pending never is. Launched items use a
 * shorter window than dismissed ones — once launched, a candidate has already
 * become a live session, so it only needs to stick around briefly as a record.
 * `ttl` is `{launchedMs, dismissedMs}`.
 */
function prunable(c, now, ttl) {
  if (c.status === 'pending') return false;
  const ts = Date.parse(c.statusAt || c.createdAt || '') || 0;
  const window = c.status === 'launched' ? ttl.launchedMs : ttl.dismissedMs;
  return now - ts > window;
}

// ---- store operations ------------------------------------------------------

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function find(id) {
  return load().candidates.find((c) => c.id === id) || null;
}

function pendingCount() {
  return load().candidates.filter((c) => c.status === 'pending').length;
}

/** Sorted snapshot for the API / SSE feed. */
function list() {
  return sortCandidates(load().candidates);
}

/**
 * Append a fully-specified candidate. Deduped on `dedupeKey` (a re-add of the
 * same logical item is a no-op that returns the existing one); rejected past
 * maxPending so nothing is ever silently dropped.
 */
function add(input) {
  load();
  const dedupeKey = input.dedupeKey;
  if (dedupeKey) {
    const existing = cache.candidates.find((c) => c.dedupeKey === dedupeKey && c.status === 'pending');
    if (existing) return existing;
  }
  if (pendingCount() >= config.CANDIDATES_MAX_PENDING) {
    throw err(429, `candidate list is full (maxPending=${config.CANDIDATES_MAX_PENDING})`);
  }
  if (!isValidSkillName(input.skill)) throw err(400, `invalid skill name: ${input.skill}`);

  const c = {
    id: newId(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    source: input.source || 'manual',
    producer: input.producer || 'user',
    priority: Number.isFinite(input.priority) ? input.priority : 0,
    action: { cwd: input.cwd, skill: (input.skill || '').trim(), prompt: (input.prompt || '').trim() },
    reason: input.reason || '',
  };
  if (input.ref) c.ref = input.ref;
  if (dedupeKey) c.dedupeKey = dedupeKey;

  cache.candidates.push(c);
  pruneInMemory();
  save();
  return c;
}

/** Edit the plan before launch: prompt / skill / cwd / reason / priority, in place. */
function update(id, patch) {
  const c = find(id);
  if (!c) return null;
  if (typeof patch.prompt === 'string') c.action.prompt = patch.prompt;
  if (typeof patch.cwd === 'string') c.action.cwd = patch.cwd.trim();
  if (typeof patch.reason === 'string') c.reason = patch.reason;
  if (typeof patch.skill === 'string') {
    if (!isValidSkillName(patch.skill)) throw err(400, `invalid skill name: ${patch.skill}`);
    c.action.skill = patch.skill.trim();
  }
  if (Number.isFinite(patch.priority)) c.priority = patch.priority;
  save();
  return c;
}

function setStatus(id, status, extra) {
  const c = find(id);
  if (!c) return null;
  c.status = status;
  c.statusAt = new Date().toISOString();
  if (extra) Object.assign(c, extra);
  save();
  return c;
}

const markLaunched = (id, sessionPid) => setStatus(id, 'launched', sessionPid ? { sessionPid } : undefined);
const dismiss = (id) => setStatus(id, 'dismissed');

/** Restore a dismissed item to the pending list. */
function undismiss(id) {
  const c = find(id);
  if (!c) return null;
  c.status = 'pending';
  delete c.statusAt;
  save();
  return c;
}

/**
 * Apply one action to many candidates in a SINGLE read-modify-write.
 *
 * The per-id endpoints would work here — the browser could just fire N of them —
 * but each one rewrites the whole JSON file, so clearing a filtered sweep of 20
 * cards means 20 full rewrites for one user gesture. This does one.
 *
 * It also reports what it *didn't* do, which the per-id path can't: a bulk action
 * is applied to a selection the user built a moment ago, so a card may have been
 * launched from another tab in between. Callers surface that ("Dismissed 11 · 1
 * had already been launched") rather than a blanket success or failure.
 *
 * `dismiss` only applies to pending candidates — dismissing an already-launched
 * one would rewrite live history. `clear` deletes whatever it is given, which is
 * the point of clear.
 */
function bulk(action, ids) {
  if (action !== 'dismiss' && action !== 'clear') {
    throw err(400, `unknown bulk action: ${action}`);
  }
  if (!Array.isArray(ids)) throw err(400, 'ids must be an array');
  load();

  const wanted = new Set(ids);
  const byId = new Map(cache.candidates.map((c) => [c.id, c]));
  const result = { action, done: 0, skipped: [], notFound: [] };
  const at = new Date().toISOString();

  for (const id of wanted) {
    const c = byId.get(id);
    if (!c) { result.notFound.push(id); continue; }
    if (action === 'dismiss' && c.status !== 'pending') {
      result.skipped.push({ id, status: c.status });
      continue;
    }
    if (action === 'dismiss') {
      c.status = 'dismissed';
      c.statusAt = at;
    }
    result.done++;
  }

  if (action === 'clear') {
    const doomed = new Set(cache.candidates.filter((c) => wanted.has(c.id)).map((c) => c.id));
    cache.candidates = cache.candidates.filter((c) => !doomed.has(c.id));
  }

  if (result.done) save(); // nothing changed → don't touch the file
  return result;
}

/** Drop a candidate from the list entirely (the ✕ Clear action). */
function remove(id) {
  load();
  const i = cache.candidates.findIndex((c) => c.id === id);
  if (i === -1) return false;
  cache.candidates.splice(i, 1);
  save();
  return true;
}

function retentionTtl() {
  return {
    launchedMs: config.CANDIDATES_LAUNCHED_RETENTION_HOURS * 3600000,
    dismissedMs: config.CANDIDATES_RETENTION_DAYS * 86400000,
  };
}

function pruneInMemory() {
  const now = Date.now();
  const ttl = retentionTtl();
  const before = cache.candidates.length;
  cache.candidates = cache.candidates.filter((c) => !prunable(c, now, ttl));
  return before - cache.candidates.length;
}

/** Periodic retention sweep: drop dismissed + old launched items, persist if any went. */
function prune() {
  load();
  if (pruneInMemory() > 0) save();
}

/** Test hook: forget the in-memory cache so the next load() re-reads from disk. */
function _reset() {
  cache = null;
  counter = 0;
}

module.exports = {
  list,
  find,
  add,
  update,
  markLaunched,
  dismiss,
  undismiss,
  remove,
  bulk,
  prune,
  pendingCount,
  // pure helpers, exported for unit tests
  isValidSkillName,
  sortCandidates,
  prunable,
  _reset,
};

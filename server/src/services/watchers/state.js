'use strict';

/**
 * Watcher state — the persistent memory that makes polling reliable across an
 * intermittently-running dashboard. Stored in ~/.claude-dashboard/watchers-state.json
 * (our own dir; never ~/.claude), one entry per watcher name:
 *
 *   {
 *     cursor: "1718550000.000123",   // newest top-level ts processed; next poll
 *                                     //   asks Slack for history strictly after it
 *     threads: { "<thread_ts>": { replyCursor, lastActivity } },  // threads we
 *                                     //   re-scan for late replies (a `@you` that
 *                                     //   arrives deep in an existing thread)
 *     seen: { "<channel>:<thread_ts>": <ms> }   // threads already staged; dedupe
 *   }
 *
 * The cursor is why downtime is safe: whatever was posted while the machine was
 * asleep is fetched on the next poll. `threads`/`seen` are pruned to a retention
 * window so the file stays small.
 */

const fs = require('fs');
const path = require('path');

const config = require('../../config');
const fsio = require('../../utils/fsio');

const FILE = path.join(config.DATA_DIR, 'watchers-state.json');

let cache = null; // { [watcherName]: { cursor, threads, seen } }

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fsio.writeJsonAtomic(FILE, cache);
}

function forWatcher(name) {
  const all = load();
  if (!all[name]) all[name] = { cursor: null, threads: {}, seen: {} };
  const w = all[name];
  if (!w.threads) w.threads = {};
  if (!w.seen) w.seen = {};
  return w;
}

/** Slack timestamps ("1718.000123") compare correctly as numbers. */
function tsGreater(a, b) {
  return parseFloat(a || 0) > parseFloat(b || 0);
}

/** Advance the top-level cursor if `ts` is newer (never moves backward). */
function advanceCursor(name, ts) {
  const w = forWatcher(name);
  if (ts && tsGreater(ts, w.cursor)) w.cursor = ts;
  return w.cursor;
}

/** Record that a thread exists / had activity, so we re-scan it for late mentions. */
function trackThread(name, threadTs, nowMs) {
  const w = forWatcher(name);
  const t = w.threads[threadTs] || { replyCursor: null, lastActivity: 0 };
  t.lastActivity = nowMs;
  w.threads[threadTs] = t;
  return t;
}

function setReplyCursor(name, threadTs, ts) {
  const w = forWatcher(name);
  const t = w.threads[threadTs];
  if (t && ts && tsGreater(ts, t.replyCursor)) t.replyCursor = ts;
}

const seenKey = (channel, threadTs) => `${channel}:${threadTs}`;

function isSeen(name, channel, threadTs) {
  return !!forWatcher(name).seen[seenKey(channel, threadTs)];
}

function markSeen(name, channel, threadTs, nowMs) {
  forWatcher(name).seen[seenKey(channel, threadTs)] = nowMs;
}

/**
 * Drop tracked threads and seen-markers older than the retention window, and cap
 * the tracked-thread count (evicting the least-recently-active) so a busy channel
 * can't grow the file without bound. Returns counts of what was pruned.
 */
function prune(name, { nowMs, threadTtlMs, seenTtlMs, maxThreads }) {
  const w = forWatcher(name);
  let threadsDropped = 0;
  let seenDropped = 0;

  for (const [ts, t] of Object.entries(w.threads)) {
    if (nowMs - (t.lastActivity || 0) > threadTtlMs) {
      delete w.threads[ts];
      threadsDropped++;
    }
  }
  const remaining = Object.entries(w.threads);
  if (remaining.length > maxThreads) {
    remaining
      .sort((a, b) => (a[1].lastActivity || 0) - (b[1].lastActivity || 0))
      .slice(0, remaining.length - maxThreads)
      .forEach(([ts]) => {
        delete w.threads[ts];
        threadsDropped++;
      });
  }
  for (const [k, ms] of Object.entries(w.seen)) {
    if (nowMs - (ms || 0) > seenTtlMs) {
      delete w.seen[k];
      seenDropped++;
    }
  }
  return { threadsDropped, seenDropped };
}

function _reset() {
  cache = null;
}

module.exports = {
  load,
  save,
  forWatcher,
  advanceCursor,
  trackThread,
  setReplyCursor,
  isSeen,
  markSeen,
  prune,
  seenKey,
  tsGreater,
  FILE,
  _reset,
};

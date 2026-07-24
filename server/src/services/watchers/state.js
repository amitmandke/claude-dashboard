'use strict';

/**
 * Watcher state — the persistent memory that makes polling reliable across an
 * intermittently-running dashboard. Stored in ~/.claude-dashboard/watchers-state.json
 * (our own dir; never ~/.claude), one entry per watcher name, and WITHIN a watcher
 * one entry per channel (each channel has its own Slack history timeline):
 *
 *   {
 *     channels: {
 *       "<channelId>": {
 *         cursor: "1718550000.000123", // newest top-level ts processed in THIS
 *                                       //   channel; next poll asks for history
 *                                       //   strictly after it ("last watched")
 *         name: "#eng-prov",            // cached friendly name (conversations.info)
 *         threads: { "<thread_ts>": { replyCursor, lastActivity } }, // threads we
 *                                       //   re-scan for late replies (a `@you`
 *                                       //   that arrives deep in an existing thread)
 *       }
 *     },
 *     seen: { "<channelId>:<thread_ts>": <ms> } // threads already staged; dedupe
 *   }
 *
 * The per-channel cursor is why downtime is safe AND why multiple channels can be
 * watched independently: whatever was posted in each channel while the machine
 * was asleep is fetched on that channel's next poll. `threads`/`seen` are pruned
 * to a retention window so the file stays small.
 */

const fs = require('fs');
const path = require('path');

const config = require('../../config');
const fsio = require('../../utils/fsio');

const FILE = path.join(config.DATA_DIR, 'watchers-state.json');

let cache = null; // { [watcherName]: { channels: {...}, seen: {...} } }

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
  if (!all[name]) all[name] = { channels: {}, seen: {} };
  const w = all[name];
  if (!w.channels) w.channels = {};
  if (!w.seen) w.seen = {};
  return w;
}

/**
 * The per-channel slice, created on first touch.
 *   cursor — advances every poll to the newest message read (internal; drives
 *            incremental reads). NOT shown to the user (it wobbles per activity).
 *   since  — the stable "watching from" point: set when the channel is first
 *            baselined and whenever the user moves it, never advanced by polling.
 *            This is what the UI shows.
 */
function forChannel(name, channelId) {
  const w = forWatcher(name);
  if (!w.channels[channelId]) w.channels[channelId] = { cursor: null, since: null, name: null, threads: {}, paused: false };
  const c = w.channels[channelId];
  if (!c.threads) c.threads = {};
  return c;
}

/** Per-channel pause: a paused channel is skipped on every poll (state kept). */
function setPaused(name, channelId, paused) {
  forChannel(name, channelId).paused = !!paused;
}
function isPaused(name, channelId) {
  const all = load();
  const c = all[name] && all[name].channels && all[name].channels[channelId];
  return !!(c && c.paused);
}

/** Slack timestamps ("1718.000123") compare correctly as numbers. */
function tsGreater(a, b) {
  return parseFloat(a || 0) > parseFloat(b || 0);
}

/** Advance a channel's cursor if `ts` is newer (never moves backward). */
function advanceCursor(name, channelId, ts) {
  const c = forChannel(name, channelId);
  if (ts && tsGreater(ts, c.cursor)) c.cursor = ts;
  return c.cursor;
}

/** Read a channel's cursor without creating state. Returns null when unknown. */
function cursorOf(name, channelId) {
  const all = load();
  const c = all[name] && all[name].channels && all[name].channels[channelId];
  return (c && c.cursor) || null;
}

/** The stable "watching from" point (falls back to the cursor for old state). */
function sinceOf(name, channelId) {
  const all = load();
  const c = all[name] && all[name].channels && all[name].channels[channelId];
  return (c && (c.since || c.cursor)) || null;
}

/** Set the stable "watching from" point without touching the advancing cursor. */
function setSince(name, channelId, ts) {
  forChannel(name, channelId).since = ts || null;
}

/**
 * Explicitly set (move) a channel's cursor — the editable "last watched" point.
 * Unlike advanceCursor this accepts any value (including moving forward past a
 * gap you handled manually). `clearThreads` wipes that channel's tracked threads
 * and the watcher's seen-markers for it, so it becomes a clean "watch from here".
 */
function setCursor(name, channelId, ts, { clearThreads = true } = {}) {
  const c = forChannel(name, channelId);
  c.cursor = ts || null;
  c.since = ts || null; // the displayed "watching from" point moves with an explicit set
  if (clearThreads) {
    c.threads = {};
    const w = forWatcher(name);
    for (const k of Object.keys(w.seen)) {
      if (k.startsWith(`${channelId}:`)) delete w.seen[k];
    }
  }
  return c.cursor;
}

/** Cache a channel's human name (from conversations.info). */
function setChannelName(name, channelId, channelName) {
  if (channelName) forChannel(name, channelId).name = channelName;
}

function channelNameOf(name, channelId) {
  const all = load();
  const c = all[name] && all[name].channels && all[name].channels[channelId];
  return (c && c.name) || null;
}

/** Channel ids this watcher has state for (i.e. has actually watched). */
function channelsOf(name) {
  const all = load();
  return all[name] && all[name].channels ? Object.keys(all[name].channels) : [];
}

/** Record that a thread exists / had activity, so we re-scan it for late mentions. */
function trackThread(name, channelId, threadTs, nowMs) {
  const c = forChannel(name, channelId);
  const t = c.threads[threadTs] || { replyCursor: null, lastActivity: 0 };
  t.lastActivity = nowMs;
  c.threads[threadTs] = t;
  return t;
}

function setReplyCursor(name, channelId, threadTs, ts) {
  const c = forChannel(name, channelId);
  const t = c.threads[threadTs];
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
 * Drop tracked threads (across all of the watcher's channels) and seen-markers
 * older than the retention window, and cap the tracked-thread count per channel
 * (evicting the least-recently-active) so a busy channel can't grow the file
 * without bound. Returns counts of what was pruned.
 */
function prune(name, { nowMs, threadTtlMs, seenTtlMs, maxThreads }) {
  const w = forWatcher(name);
  let threadsDropped = 0;
  let seenDropped = 0;

  for (const c of Object.values(w.channels)) {
    if (!c.threads) continue;
    for (const [ts, t] of Object.entries(c.threads)) {
      if (nowMs - (t.lastActivity || 0) > threadTtlMs) {
        delete c.threads[ts];
        threadsDropped++;
      }
    }
    const remaining = Object.entries(c.threads);
    if (remaining.length > maxThreads) {
      remaining
        .sort((a, b) => (a[1].lastActivity || 0) - (b[1].lastActivity || 0))
        .slice(0, remaining.length - maxThreads)
        .forEach(([ts]) => {
          delete c.threads[ts];
          threadsDropped++;
        });
    }
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
  forChannel,
  advanceCursor,
  cursorOf,
  sinceOf,
  setSince,
  setCursor,
  setPaused,
  isPaused,
  setChannelName,
  channelNameOf,
  channelsOf,
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

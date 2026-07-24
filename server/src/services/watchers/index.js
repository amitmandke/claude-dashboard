'use strict';

/**
 * Slack watcher loop — a candidate *producer*. It polls one or more channels for
 * threads that @-mention you, and stages each as a candidate session (it never
 * launches or posts anything). Design highlights:
 *
 *   - Poll-only with a persistent cursor (state.js): whatever is posted while the
 *     machine is asleep is picked up on the next poll — downtime is safe.
 *   - Late mentions: a `@you` that arrives deep in an existing thread is caught by
 *     re-scanning tracked threads' replies each tick (Slack's history endpoint
 *     doesn't return replies), bounded by a retention window + thread cap.
 *   - Whole-thread context: a qualifying thread is fetched in full and handed to
 *     the classifier (classify.js), so the plan reflects the discussion, not one
 *     line.
 *
 * `runWatcherOnce` is written with every dependency injected so the whole
 * pipeline is unit-testable against a stub Slack client with no network, timers,
 * or child processes. `start()` wires the real dependencies and schedules ticks.
 */

const config = require('../../config');
const candidatesStore = require('../candidates/store');
const skills = require('../skills');
const slack = require('./slack');
const repos = require('./repos');
const state = require('./state');
const classifier = require('./classify');
const match = require('./match');
const watcherConfig = require('./config');

const HISTORY_MAX_PAGES = 10;
const REPLIES_MAX_PAGES = 10;
const DISCOVER_MAX_PAGES = 20;

const DAY_MS = 86400000;

function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

/** confidence 0..1 -> a small candidate priority so surer items surface first. */
function priorityFor(confidence) {
  if (confidence >= 0.8) return 2;
  if (confidence >= 0.5) return 1;
  return 0;
}

/**
 * Deterministically build the prompt the launched session starts with — no LLM.
 * The skill (from the matched intent) does the actual work; this just hands it
 * the Slack context: a link back, any PR references, and the thread text.
 */
function launchPromptFrom({ threadText, prRefs = [], permalink }) {
  const parts = [];
  if (permalink) parts.push(`Slack thread: ${permalink}`);
  if (prRefs.length) parts.push(`Pull requests: ${prRefs.map((r) => `${r.repo}#${r.number}`).join(', ')}`);
  parts.push('', 'Thread (oldest first):', threadText.slice(0, 1500));
  return parts.join('\n').trim();
}

/** Fetch top-level history since the cursor, following pages up to a cap. */
async function fetchHistory(client, channel, oldest) {
  const messages = [];
  let cursor;
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const params = { channel, inclusive: false };
    if (oldest) params.oldest = oldest;
    if (cursor) params.cursor = cursor;
    const res = await client.history(params);
    messages.push(...(res.messages || []));
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    if (!res.has_more || !cursor) return { messages, capped: false };
  }
  return { messages, capped: true };
}

/** Fetch a thread's messages (parent + replies) newer than `oldest`, paginated. */
async function fetchReplies(client, channel, ts, oldest) {
  const messages = [];
  let cursor;
  for (let page = 0; page < REPLIES_MAX_PAGES; page++) {
    const params = { channel, ts, inclusive: false };
    if (oldest) params.oldest = oldest;
    if (cursor) params.cursor = cursor;
    const res = await client.replies(params);
    messages.push(...(res.messages || []));
    cursor = res.response_metadata && res.response_metadata.next_cursor;
    if (!res.has_more || !cursor) break;
  }
  return messages;
}

/** Newest Slack ts among messages (as a string), or null. */
function newestTs(messages) {
  let max = null;
  for (const m of messages) if (state.tsGreater(m.ts, max)) max = m.ts;
  return max;
}

/**
 * Channel ids the bot is a member of (auto-discovery), paginated + capped.
 * Prefers public + private, but degrades to public-only when the token lacks
 * `groups:read` — private channels also need `groups:history` to read, so a
 * public-only token can't watch them anyway. Never throws for a missing scope.
 */
async function discoverChannels(client) {
  for (const types of ['public_channel,private_channel', 'public_channel']) {
    const ids = [];
    let cursor;
    try {
      for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
        const res = await client.userConversations({ types, ...(cursor ? { cursor } : {}) });
        for (const c of res.channels || []) if (c && c.id) ids.push(c.id);
        cursor = res.response_metadata && res.response_metadata.next_cursor;
        if (!cursor) break;
      }
      return ids;
    } catch (e) {
      // fall through to the narrower type set once, then give up
      if (!/missing_scope/.test(e.message) || types === 'public_channel') throw e;
    }
  }
  return [];
}

/**
 * Scan ONE channel: fetch new top-level messages since the channel's cursor,
 * track threads, re-scan tracked threads for late replies, and return the
 * threads that qualify (a `@you` mention). Each channel owns its cursor/threads
 * in state, so channels backfill independently and can run in parallel.
 *
 * The FIRST time a channel is seen (no cursor) we baseline to NOW and fetch
 * nothing — every channel starts from the same moment, no already-posted message
 * (however recent, answered or not) is ever staged, and the first poll stays
 * instant even across many channels. From then on each poll reads only
 * cursor→now (small/quick) and advances the cursor to the newest message read,
 * so a message is never re-read; after downtime the first read is just the
 * missed window.
 */
async function scanChannel({ name, channel, qualifies, label, client, nowMs, retention }) {
  // Resolve + cache the friendly channel name (best-effort; needs channels:read/
  // groups:read — falls back to the id until the app is reinstalled with them).
  if (!state.channelNameOf(name, channel)) {
    try {
      const info = await client.info({ channel });
      const nm = info && info.channel && info.channel.name;
      if (nm) state.setChannelName(name, channel, `#${nm}`);
    } catch (e) {
      log(`ERROR watcher name=${name} channel=${channel} info: ${e.message}`);
    }
  }

  const c = state.forChannel(name, channel);
  if (!c.cursor) {
    const ts = (nowMs / 1000).toFixed(6);
    state.advanceCursor(name, channel, ts);
    state.setSince(name, channel, ts); // stable "watching from" = now
    log(`ACTION watcher name=${name} channel=${channel} note=baseline (from now; no fetch)`);
    return { qualifiers: [], scannedThreads: 0, newMessages: 0 };
  }

  const qualifiers = [];
  const { messages, capped } = await fetchHistory(client, channel, c.cursor);
  if (capped) log(`ACTION watcher name=${name} channel=${channel} note=history-capped pages=${HISTORY_MAX_PAGES}`);
  for (const msg of messages) {
    const threadId = match.threadIdOf(msg);
    state.trackThread(name, channel, threadId, nowMs);
    if (!match.isNoise(msg) && qualifies(msg)) {
      qualifiers.push({ channel, threadId, why: `${label} in message` });
    }
  }
  const newestTop = newestTs(messages);
  if (newestTop) state.advanceCursor(name, channel, newestTop);

  // Re-scan tracked threads for late replies that mention you.
  const cutoff = nowMs - retention.threadTtlMs;
  const tracked = Object.entries(c.threads)
    .filter(([, t]) => (t.lastActivity || 0) >= cutoff)
    .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0))
    .slice(0, retention.maxThreads);
  for (const [threadId, t] of tracked) {
    try {
      const replies = await fetchReplies(client, channel, threadId, t.replyCursor);
      const fresh = replies.filter((m) => state.tsGreater(m.ts, t.replyCursor));
      if (fresh.length) {
        state.trackThread(name, channel, threadId, nowMs);
        const newest = newestTs(fresh);
        if (newest) state.setReplyCursor(name, channel, threadId, newest);
        if (fresh.some((m) => !match.isNoise(m) && qualifies(m))) {
          qualifiers.push({ channel, threadId, why: `${label} in reply` });
        }
      }
    } catch (e) {
      log(`ERROR watcher name=${name} thread=${threadId} replies: ${e.message}`);
    }
  }

  return { qualifiers, scannedThreads: tracked.length, newMessages: messages.length };
}

/**
 * One polling pass for one watcher. Returns a small summary (counts) for
 * status/logging. All I/O goes through injected deps; pure orchestration.
 */
async function runWatcherOnce(watcher, deps) {
  const {
    client,
    classify = classifier.classify,
    resolveRepo = () => null,
    knownRepos = [],
    skillList = [],
    candidates = candidatesStore,
    nowMs = Date.now(),
    retention,
  } = deps;

  const name = watcher.name;
  const trigger = watcher.trigger || { type: 'mention', users: watcher.mentionUsers || [] };
  const users = trigger.users;
  const label = 'mention';
  const qualifies = (msg) => match.mentionsAny(match.fullText(msg), users);

  // A message qualifies by @-mentioning an allowlisted user (anywhere in it,
  // including a late thread reply). Every watched channel is scanned in
  // parallel; each keeps its own cursor/threads so they backfill independently.
  // `discover` watchers resolve their channel list live (every channel the bot
  // is a member of); otherwise the configured list is used.
  let channels;
  if (watcher.discover) {
    try {
      channels = await discoverChannels(client);
      log(`ACTION watcher name=${name} note=discovered channels=${channels.length}`);
    } catch (e) {
      log(`ERROR watcher name=${name} discover: ${e.message}`);
      return { staged: 0, scannedThreads: 0, newMessages: 0 };
    }
  } else {
    channels = (watcher.channels || []).filter(Boolean);
  }
  if (channels.length === 0) {
    log(`ACTION watcher name=${name} note=no-channel`);
    return { staged: 0, scannedThreads: 0, newMessages: 0 };
  }

  // a paused channel is skipped entirely — its cursor/since stay put, so resuming
  // backfills from where it left off.
  const active = channels.filter((channel) => !state.isPaused(name, channel));
  const scans = await Promise.all(
    active.map((channel) =>
      scanChannel({ name, channel, qualifies, label, client, nowMs, retention })
    )
  );

  // Gather qualifying threads across all channels (deduped by channel+thread),
  // then classify + stage SERIALLY — the classifier is one-at-a-time by design.
  const toClassify = new Map(); // "channel:thread" -> { channel, threadId, why }
  let scannedThreads = 0;
  let newMessages = 0;
  for (const s of scans) {
    scannedThreads += s.scannedThreads;
    newMessages += s.newMessages;
    for (const q of s.qualifiers) {
      const k = state.seenKey(q.channel, q.threadId);
      if (!toClassify.has(k)) toClassify.set(k, q);
    }
  }

  let staged = 0;
  for (const { channel, threadId, why } of toClassify.values()) {
    if (state.isSeen(name, channel, threadId)) continue;
    try {
      const thread = await fetchReplies(client, channel, threadId, null);
      const threadText = match.renderThread(thread);
      const prRefs = match.extractPrRefs(threadText);
      const intents = watcher.intents || [];
      const plan = await classify({ threadText, prRefs, repos: knownRepos, skills: skillList, intents });

      state.markSeen(name, channel, threadId, nowMs); // decided once, either way

      // Decide actionability + skill. Intent mode: the model only named an intent
      // and the skill comes from the config map — repo/prompt/reason are built
      // deterministically below. Free mode (no intents): trust the model's own
      // skill/repo/prompt. Unclassified fallback: always stage, no skill.
      let actionable;
      let skill;
      let matchedIntent = null;
      if (plan.unclassified) {
        actionable = true;
        skill = '';
      } else if (intents.length) {
        matchedIntent = intents.find((it) => it.name === plan.intent) || null;
        actionable = !!matchedIntent;
        skill = matchedIntent ? matchedIntent.skill : '';
      } else {
        actionable = plan.actionable;
        skill = plan.skill || '';
      }

      if (!actionable) {
        log(`ACTION watcher name=${name} thread=${threadId} skip=no-intent-match`);
        continue;
      }

      let permalink;
      try {
        const link = await client.permalink({ channel, message_ts: threadId });
        permalink = link.permalink;
      } catch {
        /* permalink is best-effort */
      }

      // Repo/prompt/reason: deterministic in intent + fallback modes; the model's
      // own picks are used only in free mode.
      const useModelPlan = !intents.length && !plan.unclassified;
      const cwd =
        (useModelPlan && resolveRepo(plan.repo)) ||
        (prRefs[0] && resolveRepo(prRefs[0].repo)) ||
        watcher.defaultCwd ||
        '';
      const prompt = useModelPlan ? plan.prompt : launchPromptFrom({ threadText, prRefs, permalink });
      let reason;
      if (matchedIntent) reason = `Slack ${label} matched intent "${matchedIntent.name}"`;
      else if (plan.unclassified) reason = plan.reason;
      else reason = plan.reason;

      candidates.add({
        cwd,
        skill,
        prompt,
        reason: reason + (cwd ? '' : ' [pick a repo before launch]'),
        priority: priorityFor(plan.confidence),
        source: 'slack',
        producer: 'watcher',
        // carry the channel name + PR refs so the card leads with "#channel" or
        // the PR ref instead of a bare "Slack thread".
        ref: { slackPermalink: permalink, channelName: state.channelNameOf(name, channel), prRefs },
        dedupeKey: state.seenKey(channel, threadId),
      });
      staged++;
      log(
        `ACTION watcher-candidate name=${name} thread=${threadId} ${why} ` +
        `intent=${matchedIntent ? matchedIntent.name : '-'} skill=${skill || '-'} conf=${plan.confidence}`
      );
    } catch (e) {
      log(`ERROR watcher name=${name} thread=${threadId} classify: ${e.message}`);
    }
  }

  state.prune(name, {
    nowMs,
    threadTtlMs: retention.threadTtlMs,
    seenTtlMs: retention.seenTtlMs,
    maxThreads: retention.maxThreads,
  });
  state.save();
  return { staged, scannedThreads, newMessages };
}

// ---- live scheduling (real dependencies) ----------------------------------
//
// One entry per configured watcher (running/paused/error/disabled) in a Map, so
// each can be controlled independently over HTTP (Pause/Resume/Run-now) without
// touching the others or the dashboard. Pause/Resume also persist to
// watchers.json (via config.setEnabled) so they survive a restart.

let started = false;
let featureOn = false; // WATCHERS_ENABLED && a config file is present
let deps = null; // built once at start(): slack client, repoMap, skillList, retention
const runtime = new Map();
// entry: { name, channels, everySeconds, trigger, state, lastPollAt, staged,
//          lastError, watcher, timer }
//   state ∈ 'running' | 'paused' | 'error' | 'disabled'
//   watcher = normalized cfg | null (null = config error, needs a file edit)
//   timer   = interval handle | null

// `buildDeps` and `scheduleInterval` are reassignable so tests can inject a fake
// Slack client and a no-op timer (see _setTestHooks) — no network, no real
// intervals leaking out of a test run.
let buildDeps = (cfg) => {
  const client = slack.createClient({ token: cfg.token });
  const repoMap = repos.create({
    base: config.WATCHERS_CODEBASE_DIR,
    preferDir: config.WATCHERS_PREFER_CHECKOUT,
  });
  const skillList = skills.listSkills('');
  const retention = {
    threadTtlMs: config.WATCHERS_THREAD_TTL_DAYS * DAY_MS,
    seenTtlMs: config.WATCHERS_SEEN_TTL_DAYS * DAY_MS,
    maxThreads: config.WATCHERS_MAX_THREADS,
  };
  return { client, repoMap, skillList, retention };
};

let scheduleInterval = (fn, ms) => setInterval(fn, ms);

function entryFromWatcher(w, state) {
  return {
    name: w.name,
    channels: w.channels || [],
    discover: !!w.discover,
    everySeconds: w.everySeconds,
    trigger: w.trigger ? w.trigger.type : null,
    state,
    lastPollAt: null,
    staged: 0,
    lastError: null,
    watcher: w,
    timer: null,
  };
}

function clearTimer(e) {
  if (e.timer) {
    clearInterval(e.timer);
    e.timer = null;
  }
}

function startTimer(e) {
  clearTimer(e);
  e.state = 'running';
  tick(e); // immediate catch-up
  e.timer = scheduleInterval(() => tick(e), e.watcher.everySeconds * 1000);
}

async function tick(entry) {
  if (!deps || !entry.watcher) return;
  try {
    const r = await runWatcherOnce(entry.watcher, {
      client: deps.client,
      resolveRepo: (rr) => deps.repoMap.resolve(rr),
      knownRepos: deps.repoMap.list(),
      skillList: deps.skillList,
      retention: deps.retention,
      nowMs: Date.now(),
    });
    entry.lastPollAt = new Date().toISOString();
    entry.staged += r.staged;
    entry.lastError = null;
    if (entry.timer) entry.state = 'running'; // leave 'paused' for a Run-now on a paused watcher
  } catch (e) {
    log(`ERROR watcher name=${entry.name} tick: ${e.message}`);
    entry.lastError = e.message;
    if (entry.timer) entry.state = 'error';
  }
}

/** Start the watcher loop from ~/.claude-dashboard/watchers.json. Idempotent. */
function start() {
  if (started) return;
  started = true;
  if (!config.WATCHERS_ENABLED) return;

  const cfg = watcherConfig.load();
  cfg.disabled.forEach((d) => log(`ACTION watcher name=${d.name} disabled=${d.reason}`));
  if (!cfg.present) return; // no config file -> feature simply off
  featureOn = true;
  if (cfg.watchers.length && !cfg.token) {
    log('ERROR watcher: watchers.json has watchers but no usable bot token (set SLACK_BOT_TOKEN)');
    featureOn = false;
    return;
  }
  if (cfg.token) deps = buildDeps(cfg);

  for (const w of cfg.watchers) {
    const e = entryFromWatcher(w, 'running');
    runtime.set(w.name, e);
    startTimer(e);
    log(`ACTION watcher name=${w.name} started channels=${w.channels.join(',')} every=${w.everySeconds}s`);
  }
  // surface enabled:false watchers as resumable 'paused' entries (config errors
  // are left out — they need a file edit, not a Resume click).
  for (const d of cfg.disabled) {
    if (d.reason === 'disabled' && !runtime.has(d.name)) {
      runtime.set(d.name, {
        name: d.name, channels: [], everySeconds: null, trigger: null,
        state: 'paused', lastPollAt: null, staged: 0, lastError: null, watcher: null, timer: null,
      });
    }
  }
}

function pause(name) {
  const e = runtime.get(name);
  if (!e) return { ok: false, error: 'unknown watcher' };
  clearTimer(e);
  e.state = 'paused';
  const persisted = watcherConfig.setEnabled(name, false);
  log(`ACTION watcher name=${name} paused persisted=${persisted}`);
  return { ok: true, persisted };
}

function resume(name) {
  const persisted = watcherConfig.setEnabled(name, true);
  const cfg = watcherConfig.load();
  const w = cfg.watchers.find((x) => x.name === name);
  if (!w) return { ok: false, error: 'watcher not found or has a config error' };
  if (!deps) {
    if (!cfg.token) return { ok: false, error: 'no usable Slack bot token' };
    deps = buildDeps(cfg);
  }
  let e = runtime.get(name);
  if (!e) {
    e = entryFromWatcher(w, 'running');
    runtime.set(name, e);
  } else {
    e.watcher = w;
    e.channels = w.channels;
    e.discover = !!w.discover;
    e.everySeconds = w.everySeconds;
    e.trigger = w.trigger ? w.trigger.type : null;
  }
  startTimer(e);
  log(`ACTION watcher name=${name} resumed persisted=${persisted}`);
  return { ok: true, persisted };
}

async function runNow(name) {
  const e = runtime.get(name);
  if (!e) return { ok: false, error: 'unknown watcher' };
  if (!e.watcher || !deps) return { ok: false, error: 'watcher is disabled — resume it first' };
  await tick(e);
  return { ok: true, staged: e.staged, lastError: e.lastError };
}

/**
 * Move a channel's "last watched" cursor — the editable observability control.
 * `at` is "now" (skip to the present, ignoring anything already handled) or a
 * date (ISO string / epoch ms) to watch from. Clears that channel's tracked
 * threads + seen-markers so it's a clean "watch from here". Persists immediately.
 */
function setChannelCursor(name, channel, at, nowMs = Date.now()) {
  const e = runtime.get(name);
  if (!e) return { ok: false, error: 'unknown watcher' };
  const watched = new Set([...(e.channels || []), ...state.channelsOf(name)]);
  if (!watched.has(channel)) return { ok: false, error: `channel ${channel} is not watched by ${name}` };

  let ms;
  if (at === 'now' || at == null) ms = nowMs;
  else if (typeof at === 'number') ms = at;
  else if (/^\d+$/.test(String(at))) ms = parseInt(at, 10);
  else {
    ms = Date.parse(at);
    if (Number.isNaN(ms)) return { ok: false, error: `invalid time: ${at}` };
  }
  const ts = (ms / 1000).toFixed(6); // Slack ts is seconds with µs precision
  state.setCursor(name, channel, ts, { clearThreads: true });
  state.save();
  log(`ACTION watcher name=${name} channel=${channel} set-cursor at=${new Date(ms).toISOString()}`);
  return { ok: true, channel, watchingSince: new Date(ms).toISOString() };
}

/** Pause or resume a single channel within a watcher (persisted in state). */
function setChannelPaused(name, channel, paused) {
  const e = runtime.get(name);
  if (!e) return { ok: false, error: 'unknown watcher' };
  const watched = new Set([...(e.channels || []), ...state.channelsOf(name)]);
  if (!watched.has(channel)) return { ok: false, error: `channel ${channel} is not watched by ${name}` };
  state.setPaused(name, channel, paused);
  state.save();
  log(`ACTION watcher name=${name} channel=${channel} ${paused ? 'paused' : 'resumed'}`);
  return { ok: true, channel, paused: !!paused };
}

function stopAll() {
  for (const e of runtime.values()) {
    clearTimer(e);
    if (e.state !== 'disabled') e.state = 'paused';
    watcherConfig.setEnabled(e.name, false);
  }
  log('ACTION watchers stop-all');
  return { ok: true };
}

function startAll() {
  for (const name of runtime.keys()) watcherConfig.setEnabled(name, true);
  const cfg = watcherConfig.load();
  if (cfg.watchers.length && !cfg.token) return { ok: false, error: 'no usable Slack bot token' };
  if (!deps && cfg.token) deps = buildDeps(cfg);
  for (const w of cfg.watchers) {
    let e = runtime.get(w.name);
    if (!e) {
      e = entryFromWatcher(w, 'running');
      runtime.set(w.name, e);
    } else {
      e.watcher = w;
      e.channels = w.channels;
      e.everySeconds = w.everySeconds;
      e.trigger = w.trigger ? w.trigger.type : null;
    }
    startTimer(e);
  }
  log('ACTION watchers start-all');
  return { ok: true };
}

/** Shutdown (no persist): clear all timers. */
function stop() {
  for (const e of runtime.values()) clearTimer(e);
  runtime.clear();
  started = false;
}

function getStatus() {
  return {
    enabled: featureOn,
    repos: deps ? deps.repoMap.list().length : 0,
    watchers: [...runtime.values()].map((e) => ({
      name: e.name,
      discover: !!e.discover,
      // explicit config channels plus any actually watched (discovered) ones
      channels: [...new Set([...(e.channels || []), ...state.channelsOf(e.name)])].map((id) => {
        const since = state.sinceOf(e.name, id);
        return {
          id,
          name: state.channelNameOf(e.name, id) || null,
          // the stable "watching from" point (not the advancing cursor); null
          // means it will baseline (start from now) on its first poll.
          watchingSince: since ? new Date(parseFloat(since) * 1000).toISOString() : null,
          paused: state.isPaused(e.name, id),
        };
      }),
      everySeconds: e.everySeconds,
      trigger: e.trigger,
      state: e.state,
      lastPollAt: e.lastPollAt,
      staged: e.staged,
      lastError: e.lastError,
    })),
  };
}

/** Test hook: forget all runtime state. */
function _reset() {
  for (const e of runtime.values()) clearTimer(e);
  runtime.clear();
  started = false;
  featureOn = false;
  deps = null;
}

/** Test hook: inject a fake deps builder and/or a no-op timer factory. */
function _setTestHooks(hooks = {}) {
  if (hooks.buildDeps) buildDeps = hooks.buildDeps;
  if (hooks.scheduleInterval) scheduleInterval = hooks.scheduleInterval;
}

module.exports = {
  start,
  stop,
  pause,
  resume,
  runNow,
  setChannelCursor,
  setChannelPaused,
  stopAll,
  startAll,
  getStatus,
  runWatcherOnce,
  priorityFor,
  fetchHistory,
  fetchReplies,
  newestTs,
  _reset,
  _setTestHooks,
};

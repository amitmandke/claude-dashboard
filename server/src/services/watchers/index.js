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

/** Find the bot<->user DM (im) channel id for the first allowlisted user. */
async function resolveDmChannel(client, users) {
  const res = await client.imList();
  const im = (res.channels || []).find((c) => users.includes(c.user));
  return im ? im.id : null;
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
  const isDm = trigger.type === 'dm';
  const toClassify = new Map(); // threadId -> reason for logging

  // For a DM trigger the channel is the bot<->user IM (resolved live); a message
  // qualifies simply by being from an allowlisted user (you forwarded it). For a
  // mention trigger the channel is configured and a message qualifies by
  // @-mentioning an allowlisted user.
  const channel = isDm ? await resolveDmChannel(client, users) : watcher.channels[0];
  if (!channel) {
    log(`ACTION watcher name=${name} note=no-dm-channel (has the bot been DMed yet?)`);
    return { staged: 0, scannedThreads: 0, newMessages: 0 };
  }
  const qualifies = isDm
    ? (msg) => users.includes(msg.user)
    : (msg) => match.mentionsAny(match.fullText(msg), users);
  const label = isDm ? 'DM' : 'mention';

  // 1) New top-level messages since the cursor. Track threads; flag qualifiers.
  // On the very first run there is no cursor: we DON'T backfill the whole channel
  // history (that would stage months-old mentions). Instead we establish a
  // baseline — record the current cursor / thread reply-cursors and stage nothing
  // — so only activity from now on is picked up. Downtime after that is still
  // backfilled, because the saved cursor is what the next poll fetches since.
  const w = state.forWatcher(name);
  const firstRun = !w.cursor;
  const { messages, capped } = await fetchHistory(client, channel, w.cursor);
  if (capped) log(`ACTION watcher name=${name} note=history-capped pages=${HISTORY_MAX_PAGES}`);
  for (const msg of messages) {
    const threadId = match.threadIdOf(msg);
    state.trackThread(name, threadId, nowMs);
    if (!firstRun && !match.isNoise(msg) && qualifies(msg)) {
      toClassify.set(threadId, `${label} in message`);
    }
  }
  const newestTop = newestTs(messages);
  if (newestTop) state.advanceCursor(name, newestTop);
  if (firstRun) log(`ACTION watcher name=${name} note=baseline (start from now; backlog skipped)`);

  // 2) Re-scan tracked threads for late replies that mention you.
  const cutoff = nowMs - retention.threadTtlMs;
  const tracked = Object.entries(w.threads)
    .filter(([, t]) => (t.lastActivity || 0) >= cutoff)
    .sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0))
    .slice(0, retention.maxThreads);
  for (const [threadId, t] of tracked) {
    try {
      const replies = await fetchReplies(client, channel, threadId, t.replyCursor);
      const fresh = replies.filter((m) => state.tsGreater(m.ts, t.replyCursor));
      if (fresh.length) {
        state.trackThread(name, threadId, nowMs);
        const newest = newestTs(fresh);
        if (newest) state.setReplyCursor(name, threadId, newest);
        if (!firstRun && fresh.some((m) => !match.isNoise(m) && qualifies(m))) {
          toClassify.set(threadId, `${label} in reply`);
        }
      }
    } catch (e) {
      log(`ERROR watcher name=${name} thread=${threadId} replies: ${e.message}`);
    }
  }

  // 3) Classify + stage each newly-qualifying thread (skip already-staged ones).
  let staged = 0;
  for (const [threadId, why] of toClassify) {
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

      let ref;
      try {
        const link = await client.permalink({ channel, message_ts: threadId });
        ref = link.permalink;
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
      const prompt = useModelPlan ? plan.prompt : launchPromptFrom({ threadText, prRefs, permalink: ref });
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
        ref,
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
  return { staged, scannedThreads: tracked.length, newMessages: messages.length };
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
      channels: e.channels,
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

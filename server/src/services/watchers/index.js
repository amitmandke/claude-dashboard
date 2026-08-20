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
const reviews = require('./reviews');
const gh = require('./gh');
const watcherConfig = require('./config');

const HISTORY_MAX_PAGES = 10;
const REPLIES_MAX_PAGES = 10;
const DISCOVER_MAX_PAGES = 20;

const DAY_MS = 86400000;

// Pseudo-channel under which a github watcher's dedupe keys live in the shared
// `seen` map, so they inherit its existing TTL pruning for free. A github watcher
// has no real channels.
const GH_SEEN_SCOPE = 'gh';
// Bound on the retire lookup per pass: a normal board holds a handful of stale
// cards, so a bigger number means something is wrong and we should not aim a
// giant aliased query at GitHub. Over the cap, the pass logs what it skipped
// (the rest are re-checked next tick) rather than silently covering less.
const RETIRE_MAX_PER_TICK = 25;

/**
 * Faults that mean "the network went away", not "this watcher is broken". A
 * laptop that sleeps produces a steady trickle of these: launchd fires the poll
 * timer inside a DarkWake window before WiFi/DNS is back, so DNS fails outright
 * and sockets opened before sleep are dead on the other side. Measured over one
 * run: 12 of 779 ticks, all self-healing on the following poll.
 *
 * They must not look like `invalid_auth` or `missing_scope`, which need you to go
 * fix a token — showing both as the same red `error` makes the honest signal
 * worthless.
 */
const TRANSIENT_ERROR_RE =
  /ENOTFOUND|ECONNRESET|EPIPE|EADDRNOTAVAIL|ETIMEDOUT|ECONNREFUSED|ENETDOWN|ENETUNREACH|EHOSTUNREACH|socket hang up|HTTP 5\d\d/i;

/** How many consecutive transient failures before we stop calling it weather. */
const OFFLINE_ESCALATE_AFTER = 5;

function isTransientError(message) {
  return TRANSIENT_ERROR_RE.test(String(message || ''));
}

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
      // carry the matching message's ts: dedupe is per MENTION, not per thread
      qualifiers.push({ channel, threadId, msgTs: msg.ts, why: `${label} in message` });
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
        // the NEWEST qualifying reply, not the first: dedupe keys off this ts, and
        // an older already-decided mention must not mask a fresh ping below it
        const hit = fresh
          .filter((m) => !match.isNoise(m) && qualifies(m))
          .reduce((best, m) => (state.tsGreater(m.ts, best && best.ts) ? m : best), null);
        if (hit) {
          qualifiers.push({ channel, threadId, msgTs: hit.ts, why: `${label} in reply` });
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

  // Two independent ways a channel sits out, kept distinct on purpose:
  //   `excluded` is durable policy from config (survives a state reset, is what
  //     the editor writes) and reclaims the channel's tracked threads;
  //   `paused` is a temporary operational toggle in state that keeps them.
  // Both leave cursor/since alone, so either one resuming backfills from where it
  // left off rather than skipping the gap.
  const excluded = new Set(watcher.excludeChannels || []);
  for (const channel of channels) {
    if (!excluded.has(channel)) continue;
    // Reclaimed lazily rather than at save time, so this also covers a
    // hand-edited config and a channel excluded while the watcher was stopped.
    const dropped = state.clearChannelTracking(name, channel);
    if (dropped) {
      log(`ACTION watcher name=${name} channel=${channel} note=excluded-cleared threads=${dropped}`);
    }
  }
  const active = channels.filter(
    (channel) => !excluded.has(channel) && !state.isPaused(name, channel)
  );
  if (active.length === 0) {
    log(`ACTION watcher name=${name} note=no-active-channel excluded=${excluded.size}`);
    state.save(); // the exclusion clears above are worth persisting
    return { staged: 0, scannedThreads: 0, newMessages: 0 };
  }
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
      // one candidate per thread per pass, keyed on its LATEST mention (an older
      // one may already be decided, which would otherwise hide the new ask)
      const k = state.seenKey(q.channel, q.threadId);
      const prev = toClassify.get(k);
      if (!prev || state.tsGreater(q.msgTs, prev.msgTs)) toClassify.set(k, q);
    }
  }

  let staged = 0;
  for (const { channel, threadId, msgTs, why } of toClassify.values()) {
    // decided once per mention: the same message never re-stages, but a fresh
    // mention in a thread handled earlier does (a follow-up ping is a new ask)
    if (state.isSeen(name, channel, threadId, msgTs)) continue;
    try {
      const thread = await fetchReplies(client, channel, threadId, null);
      const threadText = match.renderThread(thread);
      const prRefs = match.extractPrRefs(threadText);
      const intents = watcher.intents || [];

      // Resolve the permalink first so the classifier can weave it into the
      // hand-off prompt (best-effort — a missing link just omits that pointer).
      let permalink;
      try {
        const link = await client.permalink({ channel, message_ts: threadId });
        permalink = link.permalink;
      } catch {
        /* permalink is best-effort */
      }

      const plan = await classify({
        threadText,
        prRefs,
        repos: knownRepos,
        skills: skillList,
        intents,
        permalink,
      });

      state.markSeen(name, channel, threadId, msgTs, nowMs); // decided once, either way

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

      // Repo: the model's own pick is trusted only in free mode; intent/fallback
      // modes resolve it deterministically from the PR ref or the watcher default.
      const useModelPlan = !intents.length && !plan.unclassified;
      const cwd =
        (useModelPlan && resolveRepo(plan.repo)) ||
        (prRefs[0] && resolveRepo(prRefs[0].repo)) ||
        watcher.defaultCwd ||
        '';
      // Prompt: prefer the model's crisp hand-off (now authored in intent mode too),
      // and fall back to the deterministic thread dump when the model gave nothing
      // usable (empty, or the unclassified path where no classify prompt was made).
      const prompt =
        (plan.prompt && plan.prompt.trim()) || launchPromptFrom({ threadText, prRefs, permalink });
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


/**
 * One pass of a `github` review watcher: ask GitHub for the PRs awaiting my
 * review, decide (reviews.js), stage what is new.
 *
 * Deliberately has no classifier call. The skill comes from each repo's build
 * file, so this producer keeps working when the headless `claude` binary does not
 * — which is not hypothetical, it was broken for two days and degraded silently.
 *
 * Suppression lives in the shared `seen` map keyed by the *review-state* dedupe
 * key (story + tip commits), so an unchanged PR stays quiet no matter what
 * happened to its candidate, while a new commit produces a new key and resurfaces
 * as a re-review.
 */
async function runGithubWatcherOnce(watcher, deps) {
  const {
    ghClient,
    resolveRepo = () => null,
    detectStack = repos.detectStack,
    candidates = candidatesStore,
    nowMs = Date.now(),
    retention,
  } = deps;

  const name = watcher.name;
  const login = watcher.login || (await ghClient.login());

  // Two queries, one queue. `review-requested:@me` covers fresh asks — but
  // GitHub REMOVES you from requested reviewers the moment you submit any
  // review, so a PR you commented on vanishes from that search exactly when the
  // author's next push should resurface it (orchestrator#2274, live). The
  // second query asks for PRs you have reviewed; the tip-newer-than-my-review
  // rule in reviews.js then keeps only the ones that actually moved. Derived by
  // substitution so a customized search (org: filters etc.) carries over.
  const searches = [watcher.search];
  const reviewedBy = watcher.search.replace('review-requested:@me', 'reviewed-by:@me');
  if (watcher.reReviews !== false && reviewedBy !== watcher.search) searches.push(reviewedBy);

  const seen = new Set();
  const prs = [];
  let total = 0;
  for (const [i, search] of searches.entries()) {
    const r = await ghClient.reviewQueue({ login, search, first: watcher.first });
    if (i === 0) total = r.total; // the primary queue's own size
    for (const pr of r.prs) {
      const key = `${pr.repo}#${pr.number}`;
      if (seen.has(key)) continue; // in both queries (e.g. review re-requested)
      seen.add(key);
      prs.push(pr);
      if (i > 0) total++; // re-review PRs the primary queue doesn't contain
    }
  }

  const skillsByStack = watcher.skillsByStack || {};
  const plan = reviews.planCandidates(prs, {
    excludeAuthors: watcher.excludeAuthors,
    includeAuthors: watcher.includeAuthors,
    skipDrafts: watcher.skipDrafts,
    maxGroupSize: watcher.maxGroupSize,
    maxStagePerTick: watcher.maxStagePerTick,
    projects: watcher.projects,
    groupMode: watcher.group || 'story',
    template: watcher.template || undefined,
    resolveRepo,
    skillForRepo: (repo, dir) => skillsByStack[detectStack(dir)] || '',
    isStaged: (key) => state.isSeen(name, GH_SEEN_SCOPE, key),
    defaultCwd: watcher.defaultCwd,
  });

  let staged = 0;
  for (const c of plan.candidates) {
    try {
      // A fresh snapshot SUPERSEDES this watcher's stale pending cards for the
      // same work. Two ways a pending card goes stale: the PR got new commits
      // (new tip sha -> new dedupe key), or grouping shifted (a PR staged solo
      // later joins a story, or a story's membership changes as the queue
      // moves). Both left the old card behind, so one PR showed as two or three
      // candidates (tps#5556 hit three). Any pending card of this watcher that
      // shares a PR with the new one — or is a digest when the new one is a
      // digest (the batch IS the queue, overlap or not) — is replaced. Only
      // PENDING cards: a launched/dismissed one is the user's history, and its
      // dedupe/seen key already stops it re-staging unchanged.
      if (typeof candidates.list === 'function' && typeof candidates.remove === 'function') {
        const newRefs = new Set(c.prRefs.map((r) => `${r.repo}#${r.number}`));
        for (const prev of candidates.list()) {
          if (prev.status !== 'pending' || prev.source !== 'github') continue;
          if (!prev.ref || prev.ref.watcher !== name) continue;
          if (prev.dedupeKey === c.dedupeKey) continue;
          const overlaps = (prev.ref.prRefs || []).some((r) => newRefs.has(`${r.repo}#${r.number}`));
          if (overlaps || (c.digest && prev.ref.digest)) {
            candidates.remove(prev.id);
            log(`ACTION watcher name=${name} note=superseded id=${prev.id} by=${c.dedupeKey.slice(0, 60)}`);
          }
        }
      }
      candidates.add({
        cwd: c.cwd,
        skill: c.skill,
        prompt: c.prompt,
        reason: c.reason,
        priority: c.priority,
        source: 'github',
        producer: 'watcher',
        // the card leads with the story or the PR ref rather than a bare "GitHub"
        ref: { prRefs: c.prRefs, storyKey: c.storyKey, prUrl: c.url, watcher: name, digest: c.digest || undefined },
        dedupeKey: c.dedupeKey,
      });
      state.markSeen(name, GH_SEEN_SCOPE, c.dedupeKey, null, nowMs);
      staged++;
      log(
        `ACTION watcher-candidate name=${name} ` +
        `${c.digest ? `batch=${c.prRefs.length}prs` : c.storyKey ? `story=${c.storyKey}` : `pr=${c.prRefs[0].repo}#${c.prRefs[0].number}`} ` +
        `prs=${c.prRefs.length} skill=${c.skill || '-'} prio=${c.priority}`
      );
    } catch (e) {
      log(`ERROR watcher name=${name} stage ${c.dedupeKey}: ${e.message}`);
    }
  }

  // Retire pending cards whose PRs have since merged or closed. Supersede above
  // only fires when something new STAGES for a PR — but a merged PR leaves the
  // search queue entirely, so nothing stages, nothing supersedes, and pending
  // cards never prune. The card would sit on the board forever.
  //
  // Absence from the queue is only a SUSPICION (a withdrawn review request drops
  // an open PR out too), so the suspects are confirmed against GitHub in one
  // batched call, and only terminal states retire anything.
  let retired = 0;
  let settled = 0;
  // First, the free pass: cards this tick's queue says are settled. A card goes
  // settled when I have since reviewed its PRs (the round is with the author) or
  // another reviewer picked them up. Both are already answered by the data above,
  // so this costs no GitHub call and runs before the batched confirm below —
  // fewer suspects to look up, and the cap below then applies to the remainder.
  try {
    const mine = candidates.list().filter(
      (c) => c.status === 'pending' && c.source === 'github' && c.ref && c.ref.watcher === name
    );
    const byKey = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
    for (const c of reviews.retireSettled(mine, prs)) {
      const how = (c.ref.prRefs || [])
        .map((r) => `${r.repo}#${r.number}:${reviews.settledReason(byKey.get(`${r.repo}#${r.number}`))}`)
        .join(' ');
      candidates.remove(c.id);
      settled++;
      log(`ACTION watcher name=${name} note=settled id=${c.id} ${how}`);
    }
  } catch (e) {
    log(`ERROR watcher name=${name} settle: ${e.message}`);
  }

  try {
    const mine = candidates.list().filter(
      (c) => c.status === 'pending' && c.source === 'github' && c.ref && c.ref.watcher === name
    );
    let suspects = reviews.retireSuspects(mine, seen);
    if (suspects.length > RETIRE_MAX_PER_TICK) {
      log(`ACTION watcher name=${name} note=retire-capped suspects=${suspects.length} checking=${RETIRE_MAX_PER_TICK}`);
      suspects = suspects.slice(0, RETIRE_MAX_PER_TICK);
    }
    if (suspects.length && typeof ghClient.prStates === 'function') {
      // one lookup per distinct PR, however many cards reference it
      const refs = [...new Map(
        suspects.flatMap((c) => c.ref.prRefs || []).map((r) => [`${r.repo}#${r.number}`, r])
      ).values()];
      const states = await ghClient.prStates(refs);
      for (const c of suspects) {
        if (!reviews.shouldRetire(c, states)) continue;
        const how = (c.ref.prRefs || [])
          .map((r) => `${r.repo}#${r.number}=${states[`${r.repo}#${r.number}`]}`).join(',');
        candidates.remove(c.id);
        retired++;
        log(`ACTION watcher name=${name} note=retired id=${c.id} ${how}`);
      }
    }
  } catch (e) {
    // Never fail a pass over cleanup — the staging above already happened.
    log(`ERROR watcher name=${name} retire: ${e.message}`);
  }

  log(
    `ACTION watcher name=${name} note=reviewed queue=${total} eligible=${plan.selected} ` +
    `groups=${plan.groups} staged=${staged} suppressed=${plan.suppressed} ` +
    `settled=${settled} retired=${retired}`
  );

  if (retention) {
    state.prune(name, {
      nowMs,
      threadTtlMs: retention.threadTtlMs,
      seenTtlMs: retention.seenTtlMs,
      maxThreads: retention.maxThreads,
    });
  }
  state.save();
  return { staged, total, selected: plan.selected, groups: plan.groups, suppressed: plan.suppressed };
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
//          lastError, lastErrorAt, lastErrorTransient, consecutiveFailures,
//          watcher, timer, ticking }
//   state ∈ 'running' | 'offline' | 'paused' | 'error' | 'disabled'
//     offline = the network went away (sleeping laptop); self-heals, cursor
//               makes the missed poll free. error = needs you (auth/scope/config)
//   watcher = normalized cfg | null (null = config error, needs a file edit)
//   timer   = interval handle | null

// `buildDeps` and `scheduleInterval` are reassignable so tests can inject a fake
// Slack client and a no-op timer (see _setTestHooks) — no network, no real
// intervals leaking out of a test run.
/**
 * Reassignable for tests: one Slack client per bot token (no network in tests).
 * `interactive` marks a client whose calls serve a waiting UI request, so they
 * take the next pacer slot instead of queueing behind a poll's fan-out.
 */
let createClient = (token, { interactive = false } = {}) => slack.createClient({ token, interactive });

let buildDeps = (cfg) => {
  // A github-only config has no Slack token at all, and must still get deps —
  // otherwise `tick` early-returns on `!deps` and the watcher never runs.
  const client = cfg.token ? createClient(cfg.token) : null;
  // One client per bot token, built on demand: watchers can point at different
  // bots (`trigger.botRef`), and each must poll with its own token.
  const clients = new Map();
  const clientFor = (token) => {
    if (!token || token === cfg.token) return client;
    if (!clients.has(token)) clients.set(token, createClient(token));
    return clients.get(token);
  };
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
  return { client, clientFor, repoMap, skillList, retention, ghClient: createGhClient() };
};

/** Reassignable for tests: the `gh` CLI wrapper (no subprocesses in tests). */
let createGhClient = () => gh.createClient();

let scheduleInterval = (fn, ms) => setInterval(fn, ms);

// What the config says about each watcher, for the Watchers tab: the poll loop
// only ever holds `slack` watchers, so a schedule watcher's prompt/schedule (and
// any watcher's rule count) has to come from here. Refreshed wherever config is
// re-read — never per status call, which runs on every SSE tick.
let configMeta = new Map();

function noteConfigMeta(cfg) {
  configMeta = new Map(
    (cfg.all || []).map((w, i) => [
      w.name,
      {
        // position in watchers.json — the tab's stable sort key, so a card never
        // moves just because the runtime Map happened to be rebuilt differently
        order: i,
        type: w.type,
        search: w.search || '',
        rules: (w.rules || []).length,
        prompt: w.prompt || '',
        skill: w.skill || '',
        everyMinutes: w.everyMinutes || null,
        at: w.at || '',
        cron: w.cron || '',
      },
    ])
  );
}

/**
 * A runtime entry for a watcher the poll loop can't run: `paused` when it is
 * merely `enabled:false` (a Resume click revives it), otherwise `disabled` with
 * the reason (a schedule watcher — not implemented yet — or a config error).
 * Both are surfaced rather than hidden: the tab is where you notice a watcher
 * that isn't working, and its Edit button is how you fix it.
 */
function entryFromDisabled(name, reason, prev) {
  const paused = reason === 'disabled';
  return {
    name, channels: [], everySeconds: null, discover: false, excludeChannels: [], trigger: null,
    state: paused ? 'paused' : 'disabled',
    lastPollAt: prev ? prev.lastPollAt : null,
    staged: prev ? prev.staged : 0,
    lastError: paused ? null : reason,
    watcher: null, timer: null,
  };
}

/**
 * Every RUNNABLE watcher, whatever its trigger. `normalize()` keeps the kinds in
 * separate lists so the Slack poll loop can never be handed a trigger it cannot
 * execute; the control surface (resume / reconcile / start-all) has the opposite
 * need — it looks a watcher up by name and must find it regardless of kind.
 */
function runnableWatchers(cfg) {
  return [...(cfg.watchers || []), ...(cfg.githubWatchers || [])];
}

function entryFromWatcher(w, state) {
  return {
    name: w.name,
    channels: w.channels || [],
    discover: !!w.discover,
    excludeChannels: w.excludeChannels || [],
    everySeconds: w.everySeconds,
    trigger: w.trigger ? w.trigger.type : null,
    state,
    lastPollAt: null,
    staged: 0,
    lastError: null,
    lastErrorAt: null,
    lastErrorTransient: false,
    consecutiveFailures: 0,
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
  // Single-flight: a tick now paces its Slack calls (see pace.js), so a wide scan
  // can outlast the poll interval. Overlapping ticks would queue behind each
  // other and compound; skipping is free because the cursor resumes exactly
  // where the running tick leaves off. Logged, never silent.
  if (entry.ticking) {
    log(`ACTION watcher name=${entry.name} note=tick-skipped (previous pass still running)`);
    return;
  }
  entry.ticking = true;
  try {
    let r;
    if (entry.watcher.type === 'github') {
      r = await runGithubWatcherOnce(entry.watcher, {
        ghClient: deps.ghClient,
        resolveRepo: (rr) => deps.repoMap.resolve(rr),
        retention: deps.retention,
        nowMs: Date.now(),
      });
    } else {
    // poll with this watcher's own bot token when it has one (fake deps in tests
    // supply only `client`)
    const client =
      (deps.clientFor && entry.watcher.token && deps.clientFor(entry.watcher.token)) || deps.client;
    r = await runWatcherOnce(entry.watcher, {
      client,
      resolveRepo: (rr) => deps.repoMap.resolve(rr),
      knownRepos: deps.repoMap.list(),
      skillList: deps.skillList,
      retention: deps.retention,
      nowMs: Date.now(),
    });
    }
    entry.lastPollAt = new Date().toISOString();
    entry.staged += r.staged;
    entry.consecutiveFailures = 0;
    // `lastError` is the CURRENT fault, so recovery clears it (and the ⚠ line);
    // `lastErrorAt`/`lastErrorTransient` are history and survive recovery, so a
    // flap that cleared before you looked at the card is still explainable.
    entry.lastError = null;
    if (entry.timer) entry.state = 'running'; // leave 'paused' for a Run-now on a paused watcher
  } catch (e) {
    log(`ERROR watcher name=${entry.name} tick: ${e.message}`);
    entry.lastError = e.message;
    entry.lastErrorAt = new Date().toISOString();
    entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1;
    const transient = isTransientError(e.message);
    entry.lastErrorTransient = transient;
    if (entry.timer) {
      // the cursor makes a missed poll free, so a network blip is 'offline', not
      // a fault — escalate only if it stops looking like weather
      entry.state =
        transient && entry.consecutiveFailures < OFFLINE_ESCALATE_AFTER ? 'offline' : 'error';
    }
  } finally {
    entry.ticking = false;
  }
}

/** Start the watcher loop from ~/.claude-dashboard/watchers.json. Idempotent. */
function start() {
  if (started) return;
  started = true;
  if (!config.WATCHERS_ENABLED) return;

  const cfg = watcherConfig.load();
  noteConfigMeta(cfg);
  cfg.disabled.forEach((d) => log(`ACTION watcher name=${d.name} disabled=${d.reason}`));
  if (!cfg.present) return; // no config file -> feature simply off
  featureOn = true;
  if (cfg.watchers.length && !cfg.token) {
    log('ERROR watcher: watchers.json has watchers but no usable bot token (set SLACK_BOT_TOKEN)');
    // a missing Slack token disables the slack watchers, not a github one
    if (!cfg.githubWatchers.length) {
      featureOn = false;
      return;
    }
    cfg.watchers = [];
  }
  deps = buildDeps(cfg);

  for (const w of cfg.watchers) {
    const e = entryFromWatcher(w, 'running');
    runtime.set(w.name, e);
    startTimer(e);
    log(`ACTION watcher name=${w.name} started channels=${w.channels.join(',')} every=${w.everySeconds}s`);
  }
  for (const w of cfg.githubWatchers || []) {
    const e = entryFromWatcher(w, 'running');
    runtime.set(w.name, e);
    startTimer(e);
    log(`ACTION watcher name=${w.name} started type=github search="${w.search}" every=${w.everySeconds}s`);
  }
  // surface everything the loop isn't running: `enabled:false` as a resumable
  // 'paused' entry, a schedule watcher or a config error as 'disabled' + reason
  for (const d of cfg.disabled) {
    if (!runtime.has(d.name)) runtime.set(d.name, entryFromDisabled(d.name, d.reason, null));
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
  noteConfigMeta(cfg);
  const w = runnableWatchers(cfg).find((x) => x.name === name);
  if (!w) return { ok: false, error: 'watcher not found or has a config error' };
  if (!deps) {
    if (!cfg.token && w.type !== 'github') return { ok: false, error: 'no usable Slack bot token' };
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

/**
 * Sync ONE watcher's runtime entry with what the config file now says, without
 * disturbing any other watcher: restart it if it's runnable, park it as
 * `paused` if it's merely `enabled:false`, mark it `disabled` (with the reason)
 * if the config can't run it, and forget it entirely if it's gone. This is what
 * makes an edit take effect immediately instead of at the next restart.
 */
function reconcile(name) {
  const cfg = watcherConfig.load();
  noteConfigMeta(cfg);
  const existing = runtime.get(name);
  if (existing) clearTimer(existing);

  const w = runnableWatchers(cfg).find((x) => x.name === name);
  if (!w) {
    const bad = cfg.disabled.find((d) => d.name === name);
    if (!bad) {
      runtime.delete(name); // deleted from config
      return { state: 'gone' };
    }
    const e = entryFromDisabled(name, bad.reason, existing);
    runtime.set(name, e);
    return { state: e.state, reason: bad.reason };
  }

  if (!deps) {
    if (!cfg.token && w.type !== 'github') {
      runtime.set(name, { ...entryFromWatcher(w, 'disabled'), lastError: 'no usable Slack bot token' });
      return { state: 'disabled', reason: 'no usable Slack bot token' };
    }
    deps = buildDeps(cfg);
  }
  featureOn = true;
  const e = existing
    ? Object.assign(existing, {
      watcher: w, channels: w.channels, discover: !!w.discover,
      excludeChannels: w.excludeChannels || [],
      everySeconds: w.everySeconds, trigger: w.trigger ? w.trigger.type : null, lastError: null,
    })
    : entryFromWatcher(w, 'running');
  runtime.set(name, e);
  startTimer(e);
  return { state: 'running' };
}

/**
 * Create or update a watcher from the management UI: persist the patch (merge,
 * don't replace — `config.saveWatcher` validates fail-closed and refuses to
 * write a watcher that couldn't run), then reconcile just that watcher's
 * runtime. `name` is null/'' to create. A rename retires the old entry.
 */
function upsertWatcher(name, patch) {
  const saved = watcherConfig.saveWatcher(name, patch);
  if (!saved.ok) return saved;
  if (saved.renamed && name && name !== saved.name) {
    const old = runtime.get(name);
    if (old) clearTimer(old);
    runtime.delete(name);
  }
  const r = reconcile(saved.name);
  log(`ACTION watcher name=${saved.name} ${saved.created ? 'created' : 'updated'} state=${r.state}`);
  return { ok: true, name: saved.name, created: saved.created, renamed: saved.renamed, state: r.state, reason: r.reason || null };
}

/** Delete a watcher: stop its timer, drop its entry, remove it from the config. */
function removeWatcher(name) {
  const r = watcherConfig.deleteWatcher(name);
  if (!r.ok) return r;
  const e = runtime.get(name);
  if (e) clearTimer(e);
  runtime.delete(name);
  log(`ACTION watcher name=${name} deleted`);
  return { ok: true, name };
}

/**
 * Folder choices for the editor's "where does this run" picker: every discovered
 * checkout path. Uses the running watcher's repo map when there is one, else
 * builds a throwaway one (same TTL cache either way).
 */
let pickerRepos = null;
function listFolders() {
  const repoMap =
    (deps && deps.repoMap) ||
    (pickerRepos =
      pickerRepos ||
      repos.create({
        base: config.WATCHERS_CODEBASE_DIR,
        preferDir: config.WATCHERS_PREFER_CHECKOUT,
      }));
  return { base: config.WATCHERS_CODEBASE_DIR, dirs: repoMap.dirs() };
}

/**
 * The known bots, for the config UI: reference + label from config, and the
 * live identity (`auth.test`) so the dialog can say who it's signed in as. Never
 * returns a token. A bot whose reference doesn't resolve, or whose token Slack
 * rejects, comes back with `error` instead of failing the whole list.
 */
async function listBots() {
  const cfg = watcherConfig.load();
  const view = watcherConfig.editableConfig();
  const out = [];
  for (const b of view.bots) {
    const token = cfg.bots[b.ref] ? cfg.bots[b.ref].token : null;
    const row = { ...b, identity: null, error: null };
    if (!token) {
      row.error = `token reference "${b.tokenRef}" could not be read`;
    } else {
      try {
        const auth = await createClient(token, { interactive: true }).authTest();
        row.identity = { user: auth.user || null, team: auth.team || null, botId: auth.bot_id || null };
      } catch (e) {
        row.error = e.message;
      }
    }
    out.push(row);
  }
  return { bots: out };
}

/**
 * Live channel list for a bot — what the channel picker offers. Read-only
 * (`users.conversations`), paginated + capped like discovery, and degrades to
 * public-only when the token lacks `groups:read`.
 */
async function listChannels(botRef = watcherConfig.DEFAULT_BOT_REF) {
  const cfg = watcherConfig.load();
  const bot = cfg.bots[botRef];
  if (!bot) return { ok: false, error: `unknown bot "${botRef}"` };
  if (!bot.token) return { ok: false, error: `token reference "${bot.tokenRef}" could not be read` };
  // the editor is waiting on this, so it jumps the poll queue (same rate, better order)
  const client = createClient(bot.token, { interactive: true });
  for (const types of ['public_channel,private_channel', 'public_channel']) {
    const channels = [];
    let cursor;
    try {
      for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
        const res = await client.userConversations({ types, ...(cursor ? { cursor } : {}) });
        for (const c of res.channels || []) {
          if (c && c.id) {
            channels.push({
              id: c.id,
              name: c.name || null,
              isPrivate: !!c.is_private,
              archived: !!c.is_archived,
            });
          }
        }
        cursor = res.response_metadata && res.response_metadata.next_cursor;
        if (!cursor) break;
      }
      return { ok: true, botRef, private: types.includes('private_channel'), channels };
    } catch (e) {
      if (!/missing_scope/.test(e.message) || types === 'public_channel') {
        return { ok: false, error: e.message };
      }
    }
  }
  return { ok: true, botRef, private: false, channels: [] };
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
  noteConfigMeta(cfg);
  if (cfg.watchers.length && !cfg.token && !cfg.githubWatchers.length) {
    return { ok: false, error: 'no usable Slack bot token' };
  }
  if (!deps) deps = buildDeps(cfg);
  for (const w of runnableWatchers(cfg)) {
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
      // trigger type + the config-only bits the tab shows (a schedule watcher's
      // prompt/schedule, any watcher's rule count) — see `configMeta`
      ...(configMeta.get(e.name) || {}),
      discover: !!e.discover,
      // explicit config channels plus any actually watched (discovered) ones
      channels: [
        ...new Set([...(e.channels || []), ...state.channelsOf(e.name), ...(e.excludeChannels || [])]),
      ].map((id) => {
        const since = state.sinceOf(e.name, id);
        return {
          id,
          name: state.channelNameOf(e.name, id) || null,
          // the stable "watching from" point (not the advancing cursor); null
          // means it will baseline (start from now) on its first poll.
          watchingSince: since ? new Date(parseFloat(since) * 1000).toISOString() : null,
          paused: state.isPaused(e.name, id),
          // durable config denylist — distinct from `paused` so the row can say
          // WHY it isn't scanning; the two are otherwise indistinguishable.
          excluded: (e.excludeChannels || []).includes(id),
        };
      }),
      everySeconds: e.everySeconds,
      trigger: e.trigger,
      state: e.state,
      lastPollAt: e.lastPollAt,
      staged: e.staged,
      lastError: e.lastError,
      // kept after recovery so a flap that cleared before you looked is explainable
      lastErrorAt: e.lastErrorAt || null,
      lastErrorTransient: !!e.lastErrorTransient,
    }))
      // config order, then name — deterministic across restarts, pauses, renames
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name)),
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

/**
 * Test hook: inject a fake deps builder, a no-op timer factory, and/or a fake
 * Slack client factory (used by listBots/listChannels, which are otherwise the
 * only network callers outside the poll loop).
 */
function _setTestHooks(hooks = {}) {
  if (hooks.createGhClient) createGhClient = hooks.createGhClient;
  if (hooks.buildDeps) buildDeps = hooks.buildDeps;
  if (hooks.scheduleInterval) scheduleInterval = hooks.scheduleInterval;
  if (hooks.createClient) createClient = hooks.createClient;
}

module.exports = {
  start,
  stop,
  pause,
  resume,
  runNow,
  setChannelCursor,
  setChannelPaused,
  upsertWatcher,
  removeWatcher,
  listBots,
  listChannels,
  listFolders,
  reconcile,
  stopAll,
  startAll,
  getStatus,
  runWatcherOnce,
  runGithubWatcherOnce,
  isTransientError,
  priorityFor,
  fetchHistory,
  fetchReplies,
  newestTs,
  _reset,
  _setTestHooks,
};

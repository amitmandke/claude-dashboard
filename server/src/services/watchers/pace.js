'use strict';

/**
 * One shared, self-throttling queue for every Slack API call.
 *
 * The watcher fans out over channels in parallel (11 channels × ~7 tracked
 * threads = ~80 calls a tick here), which as separate chains arrives at Slack as
 * a burst and earns an immediate 429 — even though the same 80 calls spread over
 * the 120s poll interval sit well inside Slack's ~50/min tier. So the fix is
 * shape, not volume: every call goes through this queue, which runs them ONE at
 * a time with a minimum gap, and the gap answers to Slack's own backpressure.
 *
 *   - **Serial.** One call in flight; callers just await their turn, so existing
 *     `Promise.all` fan-out keeps working unchanged — it queues instead of
 *     stampeding, and no new call site can defeat the limiter by accident.
 *   - **Paced.** `minGapMs` between call starts (start-to-start), so throughput
 *     is bounded regardless of how many channels, bots, or watchers there are.
 *   - **Adaptive.** On a rate-limit signal the whole queue pauses for Slack's
 *     `Retry-After`, the gap doubles (to `maxGapMs`), and the call is retried.
 *     After `decayAfter` clean calls the gap halves back toward the floor — so
 *     pressure from Slack widens the buffer and calm narrows it again.
 *   - **Two lanes.** `run(task, { interactive: true })` takes the next gap slot
 *     instead of the last, because a person waiting on a dialog should not sit
 *     behind a background poll's fan-out. Measured before this existed: opening
 *     the watcher editor mid-poll took 11s (and a full pass would be ~70s) for
 *     two calls that need ~2.3s. Priority changes the *order*, never the rate —
 *     the gap, the 429 backoff and the serialization are identical, so Slack
 *     cannot tell the lanes apart and the limiter is still undefeatable.
 *
 * Pure over its injected `now`/`sleep`, so the whole policy is unit-testable
 * with no timers and no sockets (`slack.js` itself stays coverage-excluded).
 *
 * A task signals rate limiting by throwing an error with `rateLimited: true`
 * and optional `retryAfterMs`; anything else propagates untouched.
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createPacer({
  minGapMs = 1200,
  maxGapMs = 60000,
  decayAfter = 25,
  maxAttempts = 4,
  now = Date.now,
  sleep = defaultSleep,
  log = () => {},
} = {}) {
  let gapMs = minGapMs;
  let okStreak = 0;
  let lastStartedAt = 0;
  // Explicit queues rather than a promise chain: a chain can only ever append,
  // so an interactive call could never overtake queued background work.
  const background = [];
  const interactive = [];
  let draining = false;

  async function attempt(task) {
    for (let i = 1; ; i++) {
      const waitMs = Math.max(0, lastStartedAt + gapMs - now());
      if (waitMs > 0) await sleep(waitMs);
      lastStartedAt = now();
      try {
        const out = await task();
        okStreak += 1;
        if (okStreak >= decayAfter && gapMs > minGapMs) {
          gapMs = Math.max(minGapMs, Math.round(gapMs / 2));
          okStreak = 0;
          log(`ACTION slack pace gap=${gapMs}ms note=eased`);
        }
        return out;
      } catch (e) {
        if (!e || !e.rateLimited || i >= maxAttempts) throw e;
        okStreak = 0;
        gapMs = Math.min(maxGapMs, gapMs * 2);
        // hold the whole queue: Slack's limit is per workspace, so letting the
        // next caller through now would just earn another 429
        const pauseMs = Math.max(e.retryAfterMs || 0, gapMs);
        log(`ACTION slack pace gap=${gapMs}ms pause=${pauseMs}ms note=rate-limited attempt=${i}`);
        await sleep(pauseMs);
        lastStartedAt = now();
      }
    }
  }

  /**
   * Queue `task` (an async function). Resolves/rejects with its result.
   * `interactive` jumps ahead of queued background work — it still waits for the
   * gap, and it cannot preempt a call already in flight.
   */
  function run(task, { interactive: urgent = false } = {}) {
    return new Promise((resolve, reject) => {
      (urgent ? interactive : background).push({ task, resolve, reject });
      drain();
    });
  }

  // One drain loop owns the single in-flight slot, so `run` stays fire-and-await
  // for callers and existing `Promise.all` fan-out keeps queueing rather than
  // stampeding.
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (interactive.length || background.length) {
        const job = interactive.length ? interactive.shift() : background.shift();
        try {
          job.resolve(await attempt(job.task));
        } catch (e) {
          job.reject(e); // a failed call must not stall the queue
        }
      }
    } finally {
      draining = false;
    }
  }

  /** Current pacing state — for logging/status, not control. */
  function stats() {
    return {
      gapMs, minGapMs, maxGapMs, okStreak,
      queued: background.length + interactive.length,
      waitingInteractive: interactive.length,
    };
  }

  return { run, stats };
}

module.exports = { createPacer };

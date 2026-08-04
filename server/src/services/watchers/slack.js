'use strict';

/**
 * Minimal, zero-dependency Slack Web API client — only the read methods the
 * watcher needs. The transport is injectable (`request`) so tests exercise the
 * client against a stub instead of the network; the default hits slack.com over
 * HTTPS with a Bearer bot token.
 *
 * All calls resolve to Slack's parsed JSON and throw on `{ ok: false }` (so the
 * caller sees `slack conversations.history: not_in_channel` rather than a silent
 * empty result).
 *
 * Rate limiting is NOT handled per call: every call — across every client, so
 * across every bot and watcher — is queued through one shared pacer (`pace.js`)
 * that serializes them, spaces them, and widens the gap when Slack answers 429.
 * A burst of parallel callers therefore queues instead of earning a 429, and a
 * new call site can't defeat the limiter by forgetting to retry.
 */

const https = require('https');

const config = require('../../config');
const { createPacer } = require('./pace');

const HOST = 'slack.com';

/** Default transport: GET https://slack.com/api/<method>?<qs> with the token. */
function httpsRequest({ path, token }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: HOST, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers || {}, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The process-wide queue every Slack call passes through. */
const sharedPacer = createPacer({
  minGapMs: config.SLACK_MIN_GAP_MS,
  maxGapMs: config.SLACK_MAX_GAP_MS,
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});

/** Drop undefined/null params and stringify the rest into a query string. */
function queryString(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return qs.toString();
}

/** A 429 (or an `ok:false, error:"ratelimited"` body) → a retryable signal. */
function rateLimitedError(method, headers) {
  const retryAfter = parseInt((headers || {})['retry-after'] || '1', 10) || 1;
  const e = new Error(`slack ${method}: ratelimited`);
  e.rateLimited = true;
  e.retryAfterMs = retryAfter * 1000;
  return e;
}

/**
 * Build a client bound to one token. `request` is injectable for tests (no
 * sockets), as is `pacer` — pass a fresh one to test a client in isolation, or
 * leave it to share the process-wide queue with every other client.
 */
function createClient({ token, request = httpsRequest, pacer = sharedPacer } = {}) {
  if (!token) throw new Error('slack: missing bot token');

  function call(method, params = {}) {
    const path = `/api/${method}?${queryString(params)}`;
    // the pacer owns spacing + 429 backoff/retry for the whole process
    return pacer.run(async () => {
      const res = await request({ path, token, method });
      if (res.status === 429) throw rateLimitedError(method, res.headers);
      let data;
      try {
        data = JSON.parse(res.body);
      } catch {
        throw new Error(`slack ${method}: non-JSON response (HTTP ${res.status})`);
      }
      if (!data.ok && data.error === 'ratelimited') throw rateLimitedError(method, res.headers);
      if (!data.ok) throw new Error(`slack ${method}: ${data.error || 'unknown_error'}`);
      return data;
    });
  }

  return {
    /** Top-level messages in a channel newer than `oldest` (paginated via cursor). */
    history: (p) => call('conversations.history', { limit: 200, ...p }),
    /** All messages of a thread (parent + replies) newer than `oldest`. */
    replies: (p) => call('conversations.replies', { limit: 200, ...p }),
    /** Channel metadata (name) — needs channels:read / groups:read. */
    info: (p) => call('conversations.info', p),
    /** Channels the bot is a member of — for auto-discovery (channels:read/groups:read). */
    userConversations: (p) =>
      call('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...p }),
    /** A shareable link to a message, used as a candidate's `ref`. */
    permalink: (p) => call('chat.getPermalink', p),
    /** Who this token is — bot identity for the config UI. Needs no extra scope. */
    authTest: () => call('auth.test'),
    call,
  };
}

module.exports = { createClient, queryString, httpsRequest, sharedPacer };

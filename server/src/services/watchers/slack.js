'use strict';

/**
 * Minimal, zero-dependency Slack Web API client — only the read methods the
 * watcher needs. The transport is injectable (`request`) so tests exercise the
 * client against a stub instead of the network; the default hits slack.com over
 * HTTPS with a Bearer bot token.
 *
 * All calls resolve to Slack's parsed JSON and throw on `{ ok: false }` (so the
 * caller sees `slack conversations.history: not_in_channel` rather than a silent
 * empty result). A single automatic retry handles HTTP 429 rate limiting.
 */

const https = require('https');

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

/** Drop undefined/null params and stringify the rest into a query string. */
function queryString(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return qs.toString();
}

/**
 * Build a client bound to one token. `request` and `wait` are injectable for
 * tests (so retry/backoff needs no real timers or sockets).
 */
function createClient({ token, request = httpsRequest, wait = sleep } = {}) {
  if (!token) throw new Error('slack: missing bot token');

  async function call(method, params = {}) {
    const path = `/api/${method}?${queryString(params)}`;
    let res = await request({ path, token, method });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers['retry-after'] || '1', 10) || 1;
      await wait(retryAfter * 1000);
      res = await request({ path, token, method });
    }
    let data;
    try {
      data = JSON.parse(res.body);
    } catch {
      throw new Error(`slack ${method}: non-JSON response (HTTP ${res.status})`);
    }
    if (!data.ok) throw new Error(`slack ${method}: ${data.error || 'unknown_error'}`);
    return data;
  }

  return {
    /** Top-level messages in a channel newer than `oldest` (paginated via cursor). */
    history: (p) => call('conversations.history', { limit: 200, ...p }),
    /** All messages of a thread (parent + replies) newer than `oldest`. */
    replies: (p) => call('conversations.replies', { limit: 200, ...p }),
    /** Channel metadata (name) — needs channels:read / groups:read. */
    info: (p) => call('conversations.info', p),
    /** A shareable link to a message, used as a candidate's `ref`. */
    permalink: (p) => call('chat.getPermalink', p),
    call,
  };
}

module.exports = { createClient, queryString, httpsRequest };

'use strict';

/**
 * Pure text helpers for the watcher pipeline: detecting an @-mention of a user,
 * dropping non-message noise, extracting PR references, and rendering a Slack
 * thread into plain text for the classifier. No I/O — all unit-testable.
 */

/**
 * Does `text` @-mention `userId`? Slack encodes mentions as `<@U012ABC>` or
 * `<@U012ABC|display>`, so match the id with an optional `|display` suffix.
 */
function mentionsUser(text, userId) {
  if (!text || !userId) return false;
  return new RegExp(`<@${userId}(\\|[^>]*)?>`).test(text);
}

/** True if any of `userIds` is mentioned in `text`. */
function mentionsAny(text, userIds) {
  return (userIds || []).some((u) => mentionsUser(text, u));
}

/**
 * All human-readable text of a message, including forwarded/shared content:
 * Slack tucks a forwarded message's body into `attachments[].text/fallback`
 * (and rich content into `blocks`), not the top-level `text`. We fold those in
 * so a forwarded link/thread is visible to mention detection and the classifier.
 */
function fullText(msg) {
  if (!msg) return '';
  const parts = [typeof msg.text === 'string' ? msg.text : ''];
  for (const a of msg.attachments || []) {
    if (a && typeof a.text === 'string') parts.push(a.text);
    else if (a && typeof a.fallback === 'string') parts.push(a.fallback);
    if (a && typeof a.title === 'string') parts.push(a.title);
  }
  for (const b of msg.blocks || []) {
    if (b && b.text && typeof b.text.text === 'string') parts.push(b.text.text);
  }
  return parts.filter(Boolean).join('\n').trim();
}

/**
 * Messages that are not real human content: channel join/leave and other
 * subtype events, bot posts, and empty bodies. A forwarded message (which may
 * have empty top-level `text` but content in attachments) is NOT noise.
 */
function isNoise(msg) {
  if (!msg) return true;
  if (msg.subtype && msg.subtype !== 'thread_broadcast') return true; // join/leave/topic/etc.
  if (msg.bot_id) return true;
  if (!fullText(msg)) return true;
  return false;
}

/** The thread id a message belongs to (its own ts if it is a top-level message). */
function threadIdOf(msg) {
  return msg.thread_ts || msg.ts;
}

/** GitHub PR references (`owner/repo#123` and full PR URLs) found in text. */
function extractPrRefs(text) {
  const refs = [];
  if (!text) return refs;
  const urlRe = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gi;
  let m;
  while ((m = urlRe.exec(text))) refs.push({ repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) });
  return refs;
}

/** Render thread messages (oldest first) as `user: text` lines for the LLM. */
function renderThread(messages, { nameOf = (u) => u } = {}) {
  return (messages || [])
    .map((m) => ({ user: m.user, text: fullText(m) }))
    .filter((m) => m.text)
    .map((m) => `${nameOf(m.user) || 'unknown'}: ${m.text}`)
    .join('\n');
}

module.exports = {
  mentionsUser,
  mentionsAny,
  isNoise,
  fullText,
  threadIdOf,
  extractPrRefs,
  renderThread,
};

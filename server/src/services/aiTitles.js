'use strict';

/**
 * AI-derived session titles — summarize what each session is *about* by asking
 * Claude itself, via headless `claude -p` (billed to the user's subscription,
 * no API key needed). This fixes the recency bias of the terminal title, which
 * Claude Code rewrites after every exchange: a side question ("is it stuck?")
 * renames a PR-review session, while this service weighs the whole feed.
 *
 * Titles are cached in ~/.claude-dashboard/ai-titles.json keyed by sessionId,
 * regenerated only when a session gains a new real user turn, one generation
 * at a time. Headless runs execute in ~/.claude-dashboard/headless so the
 * session registry can recognize and hide them (they are not user sessions).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('../config');

const FILE = path.join(config.DATA_DIR, 'ai-titles.json');
const MAX_ENTRIES = 200;
const MIN_RETRY_MS = 2 * 60 * 1000; // after a failure, leave the session alone for a while
const TIMEOUT_MS = 90 * 1000;
const MAX_EVENT_LINES = 25;

let cache = null; // sessionId -> { title, turnKey, at }
const inFlight = new Set(); // sessionIds being generated right now
const lastAttempt = new Map(); // sessionId -> ms timestamp of last generation attempt
let queue = Promise.resolve(); // generations run strictly one at a time

function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  const keys = Object.keys(cache);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k];
  }
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

function get(sessionId) {
  const e = load()[sessionId];
  return e ? e.title : null;
}

/** Identifies the latest user turn — regenerate only when this changes. */
function turnKeyFor(session) {
  const userEvents = (session.events || []).filter((e) => e.kind === 'user');
  const last = userEvents[userEvents.length - 1];
  if (last && last.at) return last.at;
  return session.firstPrompt ? session.firstPrompt.at : null;
}

function buildPrompt(session) {
  const lines = [];
  if (session.firstPrompt) lines.push(`Started with: ${session.firstPrompt.text}`);
  const events = (session.events || []).slice(-MAX_EVENT_LINES);
  if (events.length) {
    lines.push('Recent activity (oldest first):');
    for (const e of events) {
      if (e.kind === 'user') lines.push(`- user: ${e.text}`);
      else if (e.kind === 'assistant') lines.push(`- assistant: ${e.text}`);
      else if (e.kind === 'tool') lines.push(`- tool ${e.tool}: ${e.detail}`);
      else if (e.kind === 'error') lines.push(`- error in ${e.tool}: ${e.detail}`);
    }
  }
  return (
    'Below is the starting prompt and recent activity of a live coding-assistant session. ' +
    'Reply with ONLY a title for the session: 3-7 words, plain text, no quotes, no trailing ' +
    'punctuation. Title the PRIMARY task being worked on — weigh sustained activity over the ' +
    'most recent message; a side question or status check does not change the task.\n\n' +
    lines.join('\n')
  );
}

/** First line, no quotes/markdown emphasis/trailing period, bounded — or null if unusable. */
function sanitize(raw) {
  if (!raw) return null;
  let t = raw.trim().split('\n')[0].trim();
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(/^["'`*_#\s]+|["'`*_\s]+$/g, '').replace(/[.。]+$/, '').trim();
  }
  if (!t || t.length < 3) return null;
  return t.slice(0, 80);
}

function runHeadless(prompt) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(config.HEADLESS_CWD, { recursive: true });
    const child = spawn(config.CLAUDE_BIN, ['-p', '--model', config.AI_TITLE_MODEL], {
      cwd: config.HEADLESS_CWD,
      env: { ...process.env, CLAUDE_DASH_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('title generation timed out'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.end(prompt);
  });
}

/**
 * Fire-and-forget: regenerate this session's title if it has a user turn the
 * cached title hasn't seen. Cheap to call on every snapshot tick.
 */
function requestRefresh(session) {
  if (!config.AI_TITLES) return;
  const id = session.sessionId;
  const turnKey = turnKeyFor(session);
  if (!turnKey) return; // nothing to summarize yet
  const cached = load()[id];
  if (cached && cached.turnKey === turnKey) return;
  if (inFlight.has(id)) return;
  if (Date.now() - (lastAttempt.get(id) || 0) < MIN_RETRY_MS) return;

  inFlight.add(id);
  lastAttempt.set(id, Date.now());
  const prompt = buildPrompt(session);
  queue = queue.then(async () => {
    try {
      const title = sanitize(await runHeadless(prompt));
      if (title) {
        cache[id] = { title, turnKey, at: Date.now() };
        save();
        log(`ACTION ai-title session=${id.slice(0, 8)} "${title}"`);
      }
    } catch (e) {
      log(`ERROR ai-title session=${id.slice(0, 8)}: ${e.message}`);
    } finally {
      inFlight.delete(id);
    }
  });
}

module.exports = { get, requestRefresh, sanitize, turnKeyFor, buildPrompt };

'use strict';

const fs = require('fs');

const config = require('../config');
const registry = require('../services/sessionRegistry');
const terminals = require('../services/terminals');
const projects = require('../services/projects');
const skills = require('../services/skills');
const customTitles = require('../services/customTitles');
const aiTitles = require('../services/aiTitles');
const transcript = require('../services/transcript');
const candidates = require('../services/candidates/store');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---- session titles, in precedence order: the user's ✎ custom title; the
// AI-derived title (headless `claude -p` summarizing the whole feed — see
// aiTitles.js); the terminal title Claude Code sets (a summary of only the
// latest exchange); the first prompt; the folder name.

// compose the prompt that gets typed into a freshly launched session: a skill
// becomes the leading `/skill`, with any prompt as its arguments. Mirrors the
// New Session launcher in app.js so the API and the web form behave identically.
function composeLaunchPrompt(skill, prompt) {
  const p = (prompt || '').trim();
  const s = (skill || '').trim();
  if (!s) return p;
  return `/${s} ${p}`.trim();
}

// shared validation + spawn used by both the New Session launcher and the
// Launch-a-candidate path. These throw an Error with a numeric `.status`; the
// route bodies catch and map it to the HTTP response (index.js would otherwise
// turn any throw into a 500).
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function validateCwd(cwd) {
  const c = (cwd || '').trim();
  if (!c) throw httpErr(400, 'cwd is required');
  if (!fs.existsSync(c) || !fs.statSync(c).isDirectory()) throw httpErr(400, `not a directory: ${c}`);
  return c;
}

function validateSkill(skill) {
  const s = (skill || '').trim();
  if (s && !/^[\w:-]+$/.test(s)) throw httpErr(400, `invalid skill name: ${s}`);
  return s;
}

// compose the leading slash-command (so callers pass a bare skill name +
// prompt), log, and spawn. The new claude process writes its own
// ~/.claude/sessions/<pid>.json a beat later, so the card surfaces on the next
// scan — we can't return the pid synchronously.
async function spawnPlan(cwd, skill, rawPrompt) {
  const prompt = composeLaunchPrompt(skill, rawPrompt);
  console.log(
    `[${new Date().toISOString()}] ACTION spawn cwd=${cwd}` +
    (skill ? ` skill=${skill}` : '') + ` prompt=${prompt.length} chars`
  );
  await terminals.spawnSession(cwd, prompt);
  return prompt;
}

function cleanTitle(raw) {
  if (!raw) return null;
  const t = raw
    .replace(/^[^\w"'/(]+\s*/, '') // spinner/status glyphs (✳ ⠐ …)
    .replace(/\s*\((node|claude)\)\s*$/i, '')
    .trim();
  // bare app name = no task summary yet
  return t && !/^claude( code)?$/i.test(t) ? t : null;
}

async function enrich(sessions) {
  for (const s of sessions) {
    s.terminal = await terminals.backendNameFor(s.pid).catch(() => null);
    s.customTitle = customTitles.get(s.sessionId);
    aiTitles.requestRefresh(s); // async; the title lands in a later snapshot
    s.aiTitle = aiTitles.get(s.sessionId);
    s.title =
      s.customTitle ||
      s.aiTitle ||
      cleanTitle(s.terminal ? await terminals.sessionTitle(s.pid) : null) ||
      (s.firstPrompt && s.firstPrompt.text.slice(0, 80)) ||
      s.project;
  }
}

// ---- SSE: push the session snapshot to all connected dashboards when it changes

const sseClients = new Set();
let lastSnapshot = '';
let sseTimer = null;
let lastPruneAt = 0;

// retention sweep runs at most once a minute, piggy-backing the snapshot tick
// (only matters while a dashboard is watching) — drops dismissed and aged-out
// launched candidates so the list stays a short, useful history.
function maybePrune() {
  const now = Date.now();
  if (now - lastPruneAt < 60000) return;
  lastPruneAt = now;
  candidates.prune();
}

async function snapshotJson() {
  maybePrune();
  const sessions = registry.collectSessions();
  await enrich(sessions);
  return JSON.stringify({
    sessions,
    candidates: candidates.list(),
    caps: { maxConcurrent: config.CANDIDATES_MAX_CONCURRENT, maxPending: config.CANDIDATES_MAX_PENDING },
    now: Date.now(),
  });
}

function ensureSseLoop() {
  if (sseTimer) return;
  sseTimer = setInterval(async () => {
    if (sseClients.size === 0) {
      clearInterval(sseTimer);
      sseTimer = null;
      return;
    }
    const snap = await snapshotJson();
    if (snap === lastSnapshot) return;
    lastSnapshot = snap;
    for (const res of sseClients) res.write(`data: ${snap}\n\n`);
  }, config.SSE_INTERVAL_MS);
}

// ---- route table

async function handle(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    json(res, 200, JSON.parse(await snapshotJson()));
    return true;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${await snapshotJson()}\n\n`);
    sseClients.add(res);
    ensureSseLoop();
    req.on('close', () => sseClients.delete(res));
    return true;
  }

  if (url.pathname === '/api/projects' && req.method === 'GET') {
    json(res, 200, { projects: projects.recentProjects() });
    return true;
  }

  if (url.pathname === '/api/skills' && req.method === 'GET') {
    json(res, 200, { skills: skills.listSkills(url.searchParams.get('cwd') || '') });
    return true;
  }

  if (url.pathname === '/api/sessions/new' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cwd = validateCwd(body.cwd);
      const skill = validateSkill(body.skill);
      const prompt = await spawnPlan(cwd, skill, body.prompt);
      json(res, 200, { ok: true, cwd, prompt });
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
    return true;
  }

  // ---- candidate sessions: a launchable, prioritized pending list a producer
  // (running session, watcher, or the user) adds to; the user launches or
  // dismisses. A candidate is inert data until Launch spawns it via the same
  // path as the New Session launcher. See services/candidates/store.js.
  if (url.pathname === '/api/candidates') {
    if (req.method === 'GET') {
      json(res, 200, { candidates: candidates.list() });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const cwd = validateCwd(body.cwd);
        const skill = validateSkill(body.skill);
        const c = candidates.add({
          cwd,
          skill,
          prompt: body.prompt,
          priority: body.priority !== undefined ? Number(body.priority) : undefined,
          reason: body.reason,
          source: body.source,
          producer: body.producer,
          ref: body.ref,
          dedupeKey: body.dedupeKey,
        });
        console.log(
          `[${new Date().toISOString()}] ACTION candidate-add id=${c.id} source=${c.source} cwd=${cwd}`
        );
        json(res, 200, { id: c.id });
      } catch (e) {
        json(res, e.status || 500, { error: e.message });
      }
      return true;
    }
  }

  const candMatch = url.pathname.match(/^\/api\/candidates\/([\w-]+)(?:\/(launch|dismiss|undismiss))?$/);
  if (candMatch) {
    const id = candMatch[1];
    const verb = candMatch[2];
    try {
      if (!verb && req.method === 'PATCH') {
        const body = await readBody(req);
        const patch = {};
        if (typeof body.prompt === 'string') patch.prompt = body.prompt;
        if (typeof body.skill === 'string') patch.skill = body.skill;
        if (body.priority !== undefined) patch.priority = Number(body.priority);
        if (!candidates.update(id, patch)) return json(res, 404, { error: 'candidate not found' }), true;
        json(res, 200, { ok: true });
        return true;
      }
      if (!verb && req.method === 'DELETE') {
        if (!candidates.remove(id)) return json(res, 404, { error: 'candidate not found' }), true;
        json(res, 200, { ok: true });
        return true;
      }
      if (verb === 'launch' && req.method === 'POST') {
        const c = candidates.find(id);
        if (!c) return json(res, 404, { error: 'candidate not found' }), true;
        if (c.status === 'launched') return json(res, 409, { error: 'candidate already launched' }), true;
        const live = registry.collectSessions().length;
        if (live >= config.CANDIDATES_MAX_CONCURRENT) {
          return json(res, 409, { error: `at the concurrency cap (${live}/${config.CANDIDATES_MAX_CONCURRENT} running)` }), true;
        }
        const cwd = validateCwd(c.action.cwd);
        const skill = validateSkill(c.action.skill);
        await spawnPlan(cwd, skill, c.action.prompt);
        candidates.markLaunched(id);
        console.log(`[${new Date().toISOString()}] ACTION candidate-launch id=${id} cwd=${cwd}`);
        json(res, 200, { ok: true });
        return true;
      }
      if (verb === 'dismiss' && req.method === 'POST') {
        if (!candidates.dismiss(id)) return json(res, 404, { error: 'candidate not found' }), true;
        json(res, 200, { ok: true });
        return true;
      }
      if (verb === 'undismiss' && req.method === 'POST') {
        if (!candidates.undismiss(id)) return json(res, 404, { error: 'candidate not found' }), true;
        json(res, 200, { ok: true });
        return true;
      }
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
      return true;
    }
  }

  const screenMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/screen$/);
  if (screenMatch && req.method === 'GET') {
    const pid = parseInt(screenMatch[1], 10);
    if (!registry.isAlive(pid)) return json(res, 410, { error: 'session process is gone' }), true;
    json(res, 200, { screen: await terminals.readScreen(pid) });
    return true;
  }

  // full text of one assistant message (feed entries are truncated to 200 chars
  // to keep SSE light) — fetched on demand when the user opens the reply popup
  const textMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/text$/);
  if (textMatch && req.method === 'GET') {
    const pid = parseInt(textMatch[1], 10);
    const session = registry.collectSessions().find((s) => s.pid === pid);
    if (!session) return json(res, 410, { error: 'session not found' }), true;
    const at = url.searchParams.get('at');
    if (!at) return json(res, 400, { error: 'at is required' }), true;
    json(res, 200, { text: transcript.assistantTextAt(session.transcriptPath, at) });
    return true;
  }

  const titleMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/title$/);
  if (titleMatch && req.method === 'POST') {
    const pid = parseInt(titleMatch[1], 10);
    const session = registry.collectSessions().find((s) => s.pid === pid);
    if (!session) return json(res, 410, { error: 'session not found' }), true;
    const body = await readBody(req);
    customTitles.set(session.sessionId, body.title);
    json(res, 200, { ok: true });
    return true;
  }

  const m = url.pathname.match(/^\/api\/sessions\/(\d+)\/(send|key|focus|end)$/);
  if (m && req.method === 'POST') {
    const pid = parseInt(m[1], 10);
    const action = m[2];
    const body = action === 'send' || action === 'key' ? await readBody(req) : {};
    console.log(
      `[${new Date().toISOString()}] ACTION ${action} pid=${pid}` +
      (action === 'key' ? ` key=${body.key}` : '') +
      (action === 'send' ? ` chars=${(body.text || '').length} enter=${body.pressEnter !== false}` : '')
    );
    if (!registry.isAlive(pid)) return json(res, 410, { error: 'session process is gone' }), true;

    if (action === 'end') {
      // graceful shutdown: interrupt whatever is running, /exit, then close the pane
      await terminals.sendKey(pid, 'escape');
      await terminals.sleep(400);
      await terminals.sendText(pid, '/exit', true);
      for (let i = 0; i < 14 && registry.isAlive(pid); i++) await terminals.sleep(500);
      if (registry.isAlive(pid)) {
        return json(res, 409, { error: 'session did not exit — it may be mid-task; use Open in iTerm' }), true;
      }
      await terminals.closePane(pid);
    } else if (action === 'focus') {
      await terminals.focus(pid);
    } else if (action === 'key') {
      if (!body.key) return json(res, 400, { error: 'key is required' }), true;
      await terminals.sendKey(pid, String(body.key));
    } else {
      if (!body.text || !body.text.trim()) return json(res, 400, { error: 'text is required' }), true;
      await terminals.sendText(pid, body.text, body.pressEnter !== false);
    }
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle, cleanTitle, composeLaunchPrompt };

'use strict';

const fs = require('fs');

const config = require('../config');
const registry = require('../services/sessionRegistry');
const terminals = require('../services/terminals');
const projects = require('../services/projects');
const skills = require('../services/skills');
const customTitles = require('../services/customTitles');

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

// ---- session titles: Claude Code writes a generated task summary into the
// terminal title (e.g. "Build session dashboard with monitoring"). Read it via
// the session's terminal backend; fall back to the first prompt, then the folder.

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
    s.title =
      s.customTitle ||
      cleanTitle(s.terminal ? await terminals.sessionTitle(s.pid) : null) ||
      (s.firstPrompt && s.firstPrompt.text.slice(0, 80)) ||
      s.project;
  }
}

// ---- SSE: push the session snapshot to all connected dashboards when it changes

const sseClients = new Set();
let lastSnapshot = '';
let sseTimer = null;

async function snapshotJson() {
  const sessions = registry.collectSessions();
  await enrich(sessions);
  return JSON.stringify({ sessions, now: Date.now() });
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
    const body = await readBody(req);
    const cwd = (body.cwd || '').trim();
    if (!cwd) return json(res, 400, { error: 'cwd is required' }), true;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return json(res, 400, { error: `not a directory: ${cwd}` }), true;
    }
    const prompt = (body.prompt || '').trim();
    console.log(`[${new Date().toISOString()}] ACTION spawn cwd=${cwd} prompt=${prompt.length} chars`);
    await terminals.spawnSession(cwd, prompt);
    json(res, 200, { ok: true });
    return true;
  }

  const screenMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/screen$/);
  if (screenMatch && req.method === 'GET') {
    const pid = parseInt(screenMatch[1], 10);
    if (!registry.isAlive(pid)) return json(res, 410, { error: 'session process is gone' }), true;
    json(res, 200, { screen: await terminals.readScreen(pid) });
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

module.exports = { handle };

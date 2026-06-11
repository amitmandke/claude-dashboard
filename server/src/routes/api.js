'use strict';

const fs = require('fs');

const config = require('../config');
const registry = require('../services/sessionRegistry');
const iterm = require('../services/iterm');
const projects = require('../services/projects');
const skills = require('../services/skills');

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

// ---- SSE: push the session snapshot to all connected dashboards when it changes

const sseClients = new Set();
let lastSnapshot = '';
let sseTimer = null;

function snapshotJson() {
  return JSON.stringify({ sessions: registry.collectSessions(), now: Date.now() });
}

function ensureSseLoop() {
  if (sseTimer) return;
  sseTimer = setInterval(() => {
    if (sseClients.size === 0) {
      clearInterval(sseTimer);
      sseTimer = null;
      return;
    }
    const snap = snapshotJson();
    if (snap === lastSnapshot) return;
    lastSnapshot = snap;
    for (const res of sseClients) res.write(`data: ${snap}\n\n`);
  }, config.SSE_INTERVAL_MS);
}

// ---- route table

async function handle(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    json(res, 200, JSON.parse(snapshotJson()));
    return true;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${snapshotJson()}\n\n`);
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
    await iterm.spawnSession(cwd, (body.prompt || '').trim());
    json(res, 200, { ok: true });
    return true;
  }

  const screenMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/screen$/);
  if (screenMatch && req.method === 'GET') {
    const pid = parseInt(screenMatch[1], 10);
    if (!registry.isAlive(pid)) return json(res, 410, { error: 'session process is gone' }), true;
    json(res, 200, { screen: await iterm.readScreen(pid) });
    return true;
  }

  const m = url.pathname.match(/^\/api\/sessions\/(\d+)\/(send|key|focus|end)$/);
  if (m && req.method === 'POST') {
    const pid = parseInt(m[1], 10);
    const action = m[2];
    if (!registry.isAlive(pid)) return json(res, 410, { error: 'session process is gone' }), true;

    if (action === 'end') {
      // graceful shutdown: interrupt whatever is running, /exit, then close the pane
      await iterm.sendKey(pid, 'escape');
      await iterm.sleep(400);
      await iterm.sendText(pid, '/exit', true);
      for (let i = 0; i < 14 && registry.isAlive(pid); i++) await iterm.sleep(500);
      if (registry.isAlive(pid)) {
        return json(res, 409, { error: 'session did not exit — it may be mid-task; use Open in iTerm' }), true;
      }
      await iterm.closePane(pid);
    } else if (action === 'focus') {
      await iterm.focus(pid);
    } else if (action === 'key') {
      const body = await readBody(req);
      if (!body.key) return json(res, 400, { error: 'key is required' }), true;
      await iterm.sendKey(pid, String(body.key));
    } else {
      const body = await readBody(req);
      if (!body.text || !body.text.trim()) return json(res, 400, { error: 'text is required' }), true;
      await iterm.sendText(pid, body.text, body.pressEnter !== false);
    }
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle };

'use strict';

/**
 * tmux backend — full feature parity via the tmux CLI; works under any host
 * terminal and on Linux. A claude pid is matched to its pane by walking the
 * pid's ancestry against the pane shells' pids.
 */

const { execFile } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

const tmux = (...args) => run('tmux', args);

/** pid -> chain of ancestor pids (incl. itself), from a single ps snapshot. */
async function ancestry(pid) {
  const out = await run('ps', ['-axo', 'pid=,ppid=']);
  const parent = new Map();
  for (const line of out.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p) parent.set(p, pp);
  }
  const chain = [];
  for (let p = pid; p && p !== 1 && chain.length < 30; p = parent.get(p)) chain.push(p);
  return chain;
}

const paneCache = new Map(); // pid -> pane id ('%3')

async function paneFor(pid) {
  if (paneCache.has(pid)) return paneCache.get(pid);
  const [chain, panes] = await Promise.all([
    ancestry(pid),
    tmux('list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'),
  ]);
  const byPid = new Map();
  for (const line of panes.trim().split('\n')) {
    const [id, panePid] = line.split(' ');
    byPid.set(Number(panePid), id);
  }
  for (const p of chain) {
    if (byPid.has(p)) {
      paneCache.set(pid, byPid.get(p));
      return byPid.get(p);
    }
  }
  throw new Error(`no tmux pane found for pid ${pid}`);
}

const KEYS = { escape: 'Escape', enter: 'Enter', up: 'Up', down: 'Down', tab: 'Tab' };

async function sendText(pid, text, pressEnter = true) {
  const pane = await paneFor(pid);
  await tmux('send-keys', '-t', pane, '-l', '--', text); // -l = literal, no key-name lookup
  if (pressEnter) {
    await sleep(300); // let Claude Code's paste detection settle (see iterm.js)
    await tmux('send-keys', '-t', pane, 'Enter');
  }
}

async function sendKey(pid, key) {
  const pane = await paneFor(pid);
  if (KEYS[key]) return void (await tmux('send-keys', '-t', pane, KEYS[key]));
  if (key.length <= 3) return void (await tmux('send-keys', '-t', pane, '-l', '--', key));
  throw new Error(`unsupported key: ${key}`);
}

/** Best effort: selects the window/pane in the attached client; cannot raise the host terminal app. */
async function focus(pid) {
  const pane = await paneFor(pid);
  await tmux('switch-client', '-t', pane).catch(() => {});
  await tmux('select-window', '-t', pane);
  await tmux('select-pane', '-t', pane);
}

async function closePane(pid) {
  const pane = await paneFor(pid);
  await tmux('kill-pane', '-t', pane);
  paneCache.delete(pid);
}

async function readScreen(pid, maxLines = 40) {
  const pane = await paneFor(pid);
  const out = await tmux('capture-pane', '-p', '-t', pane);
  const lines = out.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-maxLines).join('\n');
}

/** Claude Code sets the terminal title via OSC; tmux captures it as pane_title. */
async function sessionTitle(pid) {
  const pane = await paneFor(pid);
  const out = await tmux('display-message', '-p', '-t', pane, '#{pane_title}');
  return out.trim() || null;
}

/** New tmux window in the existing server running claude. */
async function spawnSession(cwd, prompt) {
  const cmd = prompt ? `claude ${shellQuote(prompt)}` : 'claude';
  await tmux('new-window', '-c', cwd, cmd);
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Is a tmux server reachable at all? (for spawn auto-pick) */
async function available() {
  try {
    await tmux('list-sessions');
    return true;
  } catch {
    return false;
  }
}

module.exports = { sendText, sendKey, focus, closePane, readScreen, sessionTitle, spawnSession, available };

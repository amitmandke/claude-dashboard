'use strict';

/**
 * Terminal backend dispatcher. Detects which terminal hosts each claude process
 * (from its environment) and routes the common interface to the right backend:
 *
 *   TMUX set                      → tmux       (also works under any host terminal / Linux)
 *   TERM_PROGRAM=iTerm.app        → iterm
 *   TERM_PROGRAM=Apple_Terminal   → appleTerminal
 *   anything else                 → null       (session is observe-only)
 *
 * Every backend implements: sendText, sendKey, focus, closePane, readScreen,
 * sessionTitle, spawnSession.
 */

const procEnv = require('./procEnv');
const iterm = require('./iterm');
const appleTerminal = require('./appleTerminal');
const tmux = require('./tmux');

const BACKENDS = { iterm, terminal: appleTerminal, tmux };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Backend name for a session pid, or null when unsupported. */
async function backendNameFor(pid) {
  const env = await procEnv.get(pid);
  if (!env) return null;
  if (env.tmux) return 'tmux'; // tmux first: inside tmux, pane-level targeting is the only correct route
  if (env.termProgram === 'iTerm.app') return 'iterm';
  if (env.termProgram === 'Apple_Terminal') return 'terminal';
  return null;
}

async function backendFor(pid) {
  const name = await backendNameFor(pid);
  if (!name) throw new Error(`unsupported terminal for pid ${pid} — observe-only`);
  return BACKENDS[name];
}

const sendText = async (pid, text, pressEnter) => (await backendFor(pid)).sendText(pid, text, pressEnter);
const sendKey = async (pid, key) => (await backendFor(pid)).sendKey(pid, key);
const focus = async (pid) => (await backendFor(pid)).focus(pid);
const closePane = async (pid) => (await backendFor(pid)).closePane(pid);
const readScreen = async (pid) => (await backendFor(pid)).readScreen(pid);

async function sessionTitle(pid) {
  try {
    return await (await backendFor(pid)).sessionTitle(pid);
  } catch {
    return null;
  }
}

/** Where to launch new sessions: CLAUDE_DASH_SPAWN=iterm|terminal|tmux overrides;
 *  otherwise the first available of iTerm2 → Terminal.app → tmux. */
async function spawnSession(cwd, prompt) {
  const forced = process.env.CLAUDE_DASH_SPAWN;
  if (forced) {
    if (!BACKENDS[forced]) throw new Error(`unknown CLAUDE_DASH_SPAWN: ${forced}`);
    return BACKENDS[forced].spawnSession(cwd, prompt);
  }
  const { execFile } = require('child_process');
  const appRunning = (name) =>
    new Promise((r) => execFile('pgrep', ['-xq', name], (err) => r(!err)));
  if (await appRunning('iTerm2')) return iterm.spawnSession(cwd, prompt);
  if (await appRunning('Terminal')) return appleTerminal.spawnSession(cwd, prompt);
  if (await tmux.available()) return tmux.spawnSession(cwd, prompt);
  return iterm.spawnSession(cwd, prompt); // default: launches iTerm2 if installed
}

module.exports = {
  backendNameFor,
  sendText,
  sendKey,
  focus,
  closePane,
  readScreen,
  sessionTitle,
  spawnSession,
  sleep,
};

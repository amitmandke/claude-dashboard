'use strict';

/**
 * Apple Terminal (Terminal.app) backend. Tabs are matched by tty. Two caveats
 * vs iTerm2, both inherent to Terminal.app's narrower AppleScript API:
 *  - text can only be written via `do script` (always appends a newline), so
 *    "type without Enter" uses System Events keystrokes, which require the tab
 *    to be frontmost and macOS Accessibility permission for the dashboard's host.
 *  - there is no per-pane title; the window name is used (it carries the title
 *    Claude Code sets, plus Terminal's own decorations).
 */

const { execFile } = require('child_process');
const procEnv = require('./procEnv');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOsa(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}

async function requireTty(pid) {
  const env = await procEnv.get(pid);
  if (!env || !env.tty) throw new Error(`could not resolve the tty for pid ${pid}`);
  return env.tty;
}

// Shared walker: finds the tab whose tty matches argv 1, runs `body`, returns "ok".
function findTabScript(body) {
  return `
on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is target then
          ${body}
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;
}

async function expectOk(promise) {
  const result = await promise;
  if (result !== 'ok') throw new Error('Terminal.app tab not found (was it closed?)');
  return result;
}

async function sendText(pid, text, pressEnter = true) {
  const tty = await requireTty(pid);
  if (pressEnter) {
    // do script types text + newline; the bundled newline is eaten by Claude
    // Code's paste detection, so supply Enter separately (same trick as iTerm2).
    await expectOk(runOsa(findTabScript('do script (item 2 of argv) in t'), [tty, text]));
    await sleep(300);
    await expectOk(runOsa(findTabScript('do script "" in t'), [tty]));
  } else {
    // no newline-less write API — focus the tab and synthesize keystrokes
    await focus(pid);
    await sleep(150);
    await runOsa(
      `on run argv
  tell application "System Events" to keystroke (item 1 of argv)
end run`,
      [text]
    );
  }
}

const KEY_CODES = { escape: 53, up: 126, down: 125, tab: 48, enter: 36 };

async function sendKey(pid, key) {
  if (key.length <= 3 && !KEY_CODES[key]) return sendText(pid, key, false);
  if (!KEY_CODES[key]) throw new Error(`unsupported key: ${key}`);
  await focus(pid);
  await sleep(150);
  await runOsa(`tell application "System Events" to key code ${KEY_CODES[key]}`);
}

async function focus(pid) {
  const tty = await requireTty(pid);
  const body = `
          set selected tab of w to t
          set index of w to 1
          tell application "Terminal" to activate`;
  await expectOk(runOsa(findTabScript(body), [tty]));
}

async function closePane(pid) {
  const tty = await requireTty(pid);
  await expectOk(runOsa(findTabScript('close w'), [tty]));
}

async function readScreen(pid, maxLines = 40) {
  const tty = await requireTty(pid);
  const script = `
on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is target then
          return contents of t
        end if
      end repeat
    end repeat
  end tell
  return ""
end run`;
  const text = await runOsa(script, [tty]);
  const lines = text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-maxLines).join('\n');
}

/** Window name carries the OSC title Claude Code sets (plus Terminal decorations). */
async function sessionTitle(pid) {
  const tty = await requireTty(pid).catch(() => null);
  if (!tty) return null;
  const script = `
on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is target then
          return name of w
        end if
      end repeat
    end repeat
  end tell
  return ""
end run`;
  const name = await runOsa(script, [tty]);
  // strip Terminal's own " — ttys000" / " — 80×24" style suffixes
  return name.replace(/\s+—.*$/, '').trim() || null;
}

async function spawnSession(cwd, prompt) {
  const script = `
on run argv
  set dir to item 1 of argv
  set p to item 2 of argv
  set cmd to "cd " & quoted form of dir & " && claude"
  if p is not "" then set cmd to cmd & " " & quoted form of p
  tell application "Terminal"
    activate
    do script cmd
  end tell
  return "ok"
end run`;
  const result = await runOsa(script, [cwd, prompt || '']);
  if (result !== 'ok') throw new Error('failed to open a new Terminal.app window');
}

module.exports = { sendText, sendKey, focus, closePane, readScreen, sessionTitle, spawnSession };

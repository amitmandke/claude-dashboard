'use strict';

/**
 * iTerm2 integration — routes input to the exact pane a Claude session lives in,
 * raises panes, and spawns new sessions. Uses AppleScript (osascript); macOS will
 * ask once to allow controlling iTerm2.
 *
 * Pane discovery: every claude process inherits ITERM_SESSION_ID into its
 * environment; its UUID suffix matches the iTerm2 session `id` property.
 */

const { execFile } = require('child_process');
const procEnv = require('./procEnv');

// keys we can inject for menu/permission prompts
const KEYS = {
  escape: '',
  up: '[A',
  down: '[B',
  tab: '\t',
};

async function getItermSessionId(pid) {
  const env = await procEnv.get(pid);
  return (env && env.itermId) || null;
}

function runOsa(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}

// Shared AppleScript: walk windows/tabs/sessions to find the pane whose id matches argv 1,
// then run the per-action body.
function findSessionScript(body) {
  return `
on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s contains target then
            ${body}
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;
}

async function requirePane(pid) {
  const itermId = await getItermSessionId(pid);
  if (!itermId) throw new Error(`could not resolve the iTerm2 pane for pid ${pid}`);
  return itermId;
}

async function expectOk(promise) {
  const result = await promise;
  if (result !== 'ok') throw new Error('iTerm2 pane not found (was the tab closed?)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Type text into the session's pane. pressEnter=false types without submitting.
 *
 * Claude Code's TUI treats text that arrives in one burst as a paste, so a newline
 * sent together with the text is swallowed into the pasted content instead of
 * submitting it. Type the text first, wait for paste mode to end, then send Enter
 * as a separate keystroke.
 */
async function sendText(pid, text, pressEnter = true) {
  const itermId = await requirePane(pid);
  const writeBody = 'tell s to write text (item 2 of argv) newline NO';
  await expectOk(runOsa(findSessionScript(writeBody), [itermId, text]));
  if (pressEnter) {
    await sleep(300);
    await expectOk(runOsa(findSessionScript('tell s to write text ""'), [itermId]));
  }
}

/** Send a single key/keystroke (escape, up, down, tab, enter, or any literal char like "1"). */
async function sendKey(pid, key) {
  if (key === 'enter') {
    const itermId = await requirePane(pid);
    await expectOk(runOsa(findSessionScript('tell s to write text ""'), [itermId]));
    return;
  }
  const chars = KEYS[key] || (key.length <= 3 ? key : null);
  if (!chars) throw new Error(`unsupported key: ${key}`);
  await sendText(pid, chars, false);
}

/** All iTerm2 sessions' live titles, keyed by session UUID. Claude Code sets the
 *  pane title to a generated task summary — the best "logical title" available. */
async function listSessionTitles() {
  // NB: inside the iTerm2 tell block, the bare word `tab` resolves to iTerm's
  // tab *class*, not the tab character — use an explicit separator string.
  const script = `
tell application "iTerm2"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set out to out & (id of s) & "|||" & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
  return out
end tell`;
  const text = await runOsa(script);
  const titles = new Map();
  for (const line of text.split('\n')) {
    const i = line.indexOf('|||');
    if (i > 0) titles.set(line.slice(0, i), line.slice(i + 3).trim());
  }
  return titles;
}

/** Visible terminal contents of the session's pane — used to mirror permission
 *  dialogs (command + safety warning) that exist only on screen, not in any file. */
async function readScreen(pid, maxLines = 40) {
  const itermId = await requirePane(pid);
  const script = `
on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if id of s contains target then
            return text of s
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run`;
  const text = await runOsa(script, [itermId]);
  const lines = text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-maxLines).join('\n');
}

/** Close the session's pane (closes the tab/window if it's the last pane). */
async function closePane(pid) {
  const itermId = await requirePane(pid);
  await expectOk(runOsa(findSessionScript('close s'), [itermId]));
}

// title cache: one AppleScript listing serves all sessions for a few seconds
let titleCache = new Map();
let titleCacheAt = 0;

async function sessionTitle(pid) {
  const itermId = await getItermSessionId(pid);
  if (!itermId) return null;
  if (Date.now() - titleCacheAt > 5000) {
    titleCache = await listSessionTitles();
    titleCacheAt = Date.now();
  }
  return titleCache.get(itermId) || null;
}

/** Bring the session's window/tab/pane to the front. */
async function focus(pid) {
  const itermId = await requirePane(pid);
  const body = `
            select t
            select s
            set index of w to 1
            tell application "iTerm2" to activate`;
  await expectOk(runOsa(findSessionScript(body), [itermId]));
}

/** Open a new iTerm2 window, cd into `cwd`, and launch claude [prompt].
 *  Always a fresh window — grabbing a tab inside the user's current window is
 *  disruptive and looks like tabs appearing out of nowhere. */
async function spawnSession(cwd, prompt) {
  const script = `
on run argv
  set dir to item 1 of argv
  set p to item 2 of argv
  set cmd to "cd " & quoted form of dir & " && claude"
  if p is not "" then set cmd to cmd & " " & quoted form of p
  tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    set target to current session of newWindow
    delay 0.5
    tell target to write text cmd
    return tty of target
  end tell
end run`;
  const tty = await runOsa(script, [cwd, prompt || '']);
  if (!tty.startsWith('/dev/')) throw new Error('failed to open a new iTerm2 session: ' + tty);
  return tty;
}

module.exports = {
  sendText,
  sendKey,
  focus,
  closePane,
  readScreen,
  sessionTitle,
  spawnSession,
  sleep,
};

/* Parse a Claude Code permission dialog out of the visible terminal screen.
 *
 * Claude Code renders permission prompts as a numbered menu, e.g.:
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again for `git` commands in <dir>
 *     3. No, and tell Claude what to do differently (esc)
 *
 * But for a command it can't form a reusable allow-rule for (a compound command
 * like `cd X && git … && grep …`), it DROPS the "don't ask again" line, leaving a
 * TWO-option menu where option 2 is the No/Esc choice:
 *   ❯ 1. Yes
 *     2. No, and tell Claude what to do differently (esc)
 *
 * So the digit for "approve once" and "always allow" must be read from the real
 * options, never assumed: blindly sending "2" denies on a two-option dialog (it
 * behaves exactly like pressing Esc). This is why the dashboard's Always button
 * is hidden unless a genuine don't-ask-again option is present. */

'use strict';

// One numbered option line, tolerating the box border (│) and selection caret (❯)
// that iTerm's screen text carries, plus trailing border/whitespace.
const OPTION_RE = /^[\s│|>›❯◆•*-]*(\d{1,2})[.)]\s+(.+?)[\s│|]*$/;

function parseDialogOptions(screen) {
  const options = [];
  for (const raw of String(screen || '').split('\n')) {
    const m = raw.match(OPTION_RE);
    if (m) options.push({ num: m[1], label: m[2] });
  }

  let approveDigit = null;
  let alwaysDigit = null;
  for (const { num, label } of options) {
    const l = label.toLowerCase();
    const affirmative = /^yes\b/.test(l);
    // "yes, and don't ask again…", "yes, allow all edits…", "yes, and always…"
    const dontAskAgain = /don.?t ask again|allow all|\balways\b|yes,? and\b/.test(l);
    if (affirmative && dontAskAgain) {
      if (!alwaysDigit) alwaysDigit = num;
    } else if (affirmative) {
      if (!approveDigit) approveDigit = num;
    }
  }

  return {
    options,
    approveDigit,        // null when no plain "Yes" line was parsed
    alwaysDigit,         // null when there is no don't-ask-again option (two-option dialog)
    hasDialog: options.length >= 2,
  };
}

// browser uses this as a global; Node (tests) can require it
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseDialogOptions };
}

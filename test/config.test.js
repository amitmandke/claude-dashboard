'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const config = require('../server/src/config');
const { resolveClaudeBin } = config;

/** Build injectable deps where only the listed paths are executable. */
function deps({ home = '/home/u', executable = [], onPath = null, env = {} } = {}) {
  const seen = { whichCalls: 0 };
  return {
    args: {
      env,
      home,
      isExecutable: (p) => executable.includes(p),
      which: () => {
        seen.whichCalls++;
        return onPath;
      },
    },
    seen,
  };
}

const LOCAL = path.join('/home/u', '.local', 'bin', 'claude');
const LEGACY = path.join('/home/u', '.claude', 'local', 'claude');

test('resolveClaudeBin: explicit override wins verbatim, without probing', () => {
  const d = deps({ env: { CLAUDE_DASH_CLAUDE_BIN: '/custom/claude' }, executable: [LOCAL] });
  assert.strictEqual(resolveClaudeBin(d.args), '/custom/claude');
  assert.strictEqual(d.seen.whichCalls, 0);
});

test('resolveClaudeBin: prefers the native installer symlink in ~/.local/bin', () => {
  // the regression: launchd PATH lacks ~/.local/bin, so a bare name would ENOENT
  const d = deps({ executable: [LOCAL, '/opt/homebrew/bin/claude'], onPath: '/opt/homebrew/bin/claude' });
  assert.strictEqual(resolveClaudeBin(d.args), LOCAL);
  assert.strictEqual(d.seen.whichCalls, 0, 'no subprocess when the common path hits');
});

test('resolveClaudeBin: falls back to PATH lookup when ~/.local/bin is absent', () => {
  const d = deps({ executable: ['/opt/homebrew/bin/claude'], onPath: '/opt/homebrew/bin/claude' });
  assert.strictEqual(resolveClaudeBin(d.args), '/opt/homebrew/bin/claude');
});

test('resolveClaudeBin: ignores a PATH hit that is not executable', () => {
  const d = deps({ executable: [LEGACY], onPath: '/stale/claude' });
  assert.strictEqual(resolveClaudeBin(d.args), LEGACY);
});

test('resolveClaudeBin: falls back to the pre-native install location', () => {
  const d = deps({ executable: [LEGACY] });
  assert.strictEqual(resolveClaudeBin(d.args), LEGACY);
});

test('resolveClaudeBin: last resort is the bare name, so spawn reports ENOENT as before', () => {
  const d = deps({});
  assert.strictEqual(resolveClaudeBin(d.args), 'claude');
});

test('config.CLAUDE_BIN is resolved at load and is a non-empty string', () => {
  assert.strictEqual(typeof config.CLAUDE_BIN, 'string');
  assert.ok(config.CLAUDE_BIN.length > 0);
});

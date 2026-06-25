'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseDialogOptions } = require('../web/public/dialog.js');

test('three-option dialog: approve=1, always=2', () => {
  const screen = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    "  2. Yes, and don't ask again for `git` commands in /Users/x/repo",
    '  3. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  const r = parseDialogOptions(screen);
  assert.equal(r.approveDigit, '1');
  assert.equal(r.alwaysDigit, '2');
  assert.equal(r.hasDialog, true);
});

test('two-option dialog has NO always option (the bug: 2 == No, not "always")', () => {
  const screen = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  const r = parseDialogOptions(screen);
  assert.equal(r.approveDigit, '1');
  assert.equal(r.alwaysDigit, null);
  assert.equal(r.hasDialog, true);
});

test('parses option lines wrapped in the box border iTerm renders', () => {
  const screen = [
    '│ Do you want to proceed?                                  │',
    '│ ❯ 1. Yes                                                 │',
    "│   2. Yes, allow all edits this session                   │",
    '│   3. No, and tell Claude what to do differently (esc)    │',
  ].join('\n');
  const r = parseDialogOptions(screen);
  assert.equal(r.approveDigit, '1');
  assert.equal(r.alwaysDigit, '2');
});

test('edit-file dialog: "allow all edits" counts as the always option', () => {
  const screen = '❯ 1. Yes\n  2. Yes, allow all edits during this session (shift+tab)\n  3. No (esc)';
  const r = parseDialogOptions(screen);
  assert.equal(r.approveDigit, '1');
  assert.equal(r.alwaysDigit, '2');
});

test('no dialog on screen: nothing parsed, no digits', () => {
  const r = parseDialogOptions('just some output\n  ⎿  Interrupted · What should Claude do instead?');
  assert.equal(r.approveDigit, null);
  assert.equal(r.alwaysDigit, null);
  assert.equal(r.hasDialog, false);
});

test('empty / nullish input is safe', () => {
  for (const v of [undefined, null, '', '\n\n']) {
    const r = parseDialogOptions(v);
    assert.equal(r.hasDialog, false);
    assert.equal(r.alwaysDigit, null);
  }
});

test('non-Yes numbered options (AskUserQuestion) yield no approve/always digit', () => {
  // Custom-answer prompts are not Yes/always menus — Always must stay hidden.
  const screen = '❯ 1. Verify root-cause fit\n  2. Just summarize\n  3. Something else';
  const r = parseDialogOptions(screen);
  assert.equal(r.alwaysDigit, null);
  assert.equal(r.approveDigit, null);
});

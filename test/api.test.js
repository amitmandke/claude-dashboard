'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { cleanTitle, composeLaunchPrompt } = require('../server/src/routes/api');

test('cleanTitle strips leading spinner/status glyphs', () => {
  assert.equal(cleanTitle('✳ Build the dashboard'), 'Build the dashboard');
});

test('cleanTitle strips a trailing (node)/(claude) suffix', () => {
  assert.equal(cleanTitle('My session (node)'), 'My session');
  assert.equal(cleanTitle('My session (claude)'), 'My session');
});

test('cleanTitle rejects the bare app name (no task summary yet)', () => {
  assert.equal(cleanTitle('Claude'), null);
  assert.equal(cleanTitle('claude code'), null);
});

test('cleanTitle returns null for empty input', () => {
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle(null), null);
});

test('cleanTitle passes a normal title through', () => {
  assert.equal(cleanTitle('Investigate the OOM in the parser'), 'Investigate the OOM in the parser');
});

test('composeLaunchPrompt with no skill returns the trimmed prompt', () => {
  assert.equal(composeLaunchPrompt('', '  fix the bug  '), 'fix the bug');
  assert.equal(composeLaunchPrompt(null, 'review PR 42'), 'review PR 42');
});

test('composeLaunchPrompt with a skill prepends the slash-command', () => {
  assert.equal(composeLaunchPrompt('review-foo', 'PR 42'), '/review-foo PR 42');
});

test('composeLaunchPrompt with a skill and no prompt is just the command', () => {
  assert.equal(composeLaunchPrompt('review-foo', ''), '/review-foo');
  assert.equal(composeLaunchPrompt('review-foo', null), '/review-foo');
});

test('composeLaunchPrompt returns empty string when nothing is given', () => {
  assert.equal(composeLaunchPrompt('', ''), '');
  assert.equal(composeLaunchPrompt(null, null), '');
});

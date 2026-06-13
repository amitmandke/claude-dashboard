'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { cleanTitle } = require('../server/src/routes/api');

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

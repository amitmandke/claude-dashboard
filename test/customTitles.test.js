'use strict';

// Point the data dir at a throwaway temp dir BEFORE requiring the module, so
// the test never touches the real ~/.claude-dashboard. node --test runs each
// test file in its own process, so this env is isolated to this file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.CLAUDE_DASH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-'));

const { test } = require('node:test');
const assert = require('node:assert');
const customTitles = require('../server/src/services/customTitles');

test('set then get round-trips a title', () => {
  customTitles.set('sess-1', 'My Session');
  assert.equal(customTitles.get('sess-1'), 'My Session');
});

test('an empty or blank title clears the override', () => {
  customTitles.set('sess-2', 'temp');
  customTitles.set('sess-2', '   ');
  assert.equal(customTitles.get('sess-2'), null);
});

test('titles are capped at 120 characters', () => {
  customTitles.set('sess-3', 'x'.repeat(500));
  assert.equal(customTitles.get('sess-3').length, 120);
});

test('get returns null for an unknown session', () => {
  assert.equal(customTitles.get('never-set'), null);
});

test('titles persist to disk', () => {
  customTitles.set('sess-4', 'Persisted');
  const file = path.join(process.env.CLAUDE_DASH_DATA_DIR, 'titles.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk['sess-4'], 'Persisted');
});

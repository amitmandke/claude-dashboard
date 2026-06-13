'use strict';

// Point the data dir at a temp dir BEFORE requiring the module, and seed a
// cache file, so the get()/load() path is exercised without touching the real
// ~/.claude-dashboard. node --test isolates each test file in its own process.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aititles-'));
process.env.CLAUDE_DASH_DATA_DIR = dataDir;
fs.writeFileSync(
  path.join(dataDir, 'ai-titles.json'),
  JSON.stringify({ 'sess-cached': { title: 'Cached title', turnKey: 't1', at: 1 } })
);

const { test } = require('node:test');
const assert = require('node:assert');

const ai = require('../server/src/services/aiTitles');

test('get returns a cached title and null for unknown sessions', () => {
  assert.equal(ai.get('sess-cached'), 'Cached title');
  assert.equal(ai.get('sess-unknown'), null);
});

test('sanitize strips quotes, markdown emphasis, and trailing period', () => {
  assert.equal(ai.sanitize('**Reviewing open PRs**'), 'Reviewing open PRs');
  assert.equal(ai.sanitize('"Fix IPAM race".'), 'Fix IPAM race');
  assert.equal(ai.sanitize('# _Title_'), 'Title');
});

test('sanitize keeps only the first line', () => {
  assert.equal(ai.sanitize('A good title\nignored second line'), 'A good title');
});

test('sanitize rejects too-short output', () => {
  assert.equal(ai.sanitize('ok'), null);
  assert.equal(ai.sanitize(''), null);
  assert.equal(ai.sanitize(null), null);
});

test('sanitize caps length at 80', () => {
  assert.equal(ai.sanitize('x'.repeat(200)).length, 80);
});

test('turnKeyFor uses the latest user event timestamp', () => {
  const session = {
    firstPrompt: { at: 't0' },
    events: [
      { kind: 'user', at: 't1' },
      { kind: 'assistant', at: 't2' },
      { kind: 'user', at: 't3' },
    ],
  };
  assert.equal(ai.turnKeyFor(session), 't3');
});

test('turnKeyFor falls back to the first prompt, then null', () => {
  assert.equal(ai.turnKeyFor({ firstPrompt: { at: 't0' }, events: [] }), 't0');
  assert.equal(ai.turnKeyFor({ events: [] }), null);
});

test('buildPrompt includes the starting prompt and recent activity', () => {
  const prompt = ai.buildPrompt({
    firstPrompt: { text: 'review the PR' },
    events: [
      { kind: 'user', text: 'is it stuck?' },
      { kind: 'tool', tool: 'Bash', detail: 'gh pr view' },
    ],
  });
  assert.ok(prompt.includes('Started with: review the PR'));
  assert.ok(prompt.includes('is it stuck?'));
  assert.ok(prompt.includes('tool Bash'));
  assert.ok(/title/i.test(prompt)); // instructs the model to produce a title
});

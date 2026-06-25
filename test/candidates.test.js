'use strict';

// Point the data dir at a throwaway temp dir and pin small caps BEFORE
// requiring the module, so the test never touches the real ~/.claude-dashboard.
// node --test runs each file in its own process, so this env is file-local.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.CLAUDE_DASH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-'));
process.env.CLAUDE_DASH_MAX_PENDING = '3';

const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../server/src/services/candidates/store');

const DATA_DIR = process.env.CLAUDE_DASH_DATA_DIR;
const FILE = path.join(DATA_DIR, 'candidates.json');

// start each test from an empty, persisted-clean list
function fresh() {
  try { fs.unlinkSync(FILE); } catch {}
  store._reset();
}

// ---- pure helpers ----------------------------------------------------------

test('isValidSkillName: bare command words and empty pass; spaces/slashes fail', () => {
  assert.equal(store.isValidSkillName(''), true);
  assert.equal(store.isValidSkillName('review-go'), true);
  assert.equal(store.isValidSkillName('plugin:skill'), true);
  assert.equal(store.isValidSkillName('bad name'), false);
  assert.equal(store.isValidSkillName('/leading-slash'), false);
});

test('sortCandidates: pending first by priority desc then oldest first; history after; input untouched', () => {
  const input = [
    { id: 'd', status: 'dismissed', statusAt: '2026-06-16T10:00:00Z' },
    { id: 'p-lo-new', status: 'pending', priority: 0, createdAt: '2026-06-16T12:00:00Z' },
    { id: 'p-hi', status: 'pending', priority: 5, createdAt: '2026-06-16T11:00:00Z' },
    { id: 'l', status: 'launched', statusAt: '2026-06-16T09:00:00Z' },
    { id: 'p-lo-old', status: 'pending', priority: 0, createdAt: '2026-06-16T08:00:00Z' },
  ];
  const frozen = JSON.stringify(input);
  // pending (priority desc, then oldest first), then history grouped by status
  // rank (launched before dismissed), most-recent within a group.
  const out = store.sortCandidates(input).map((c) => c.id);
  assert.deepEqual(out, ['p-hi', 'p-lo-old', 'p-lo-new', 'l', 'd']);
  assert.equal(JSON.stringify(input), frozen); // pure: no mutation
});

test('prunable: pending never; launched uses a short window, dismissed a long one', () => {
  const now = Date.parse('2026-06-16T00:00:00Z');
  const ttl = { launchedMs: 2 * 3600000, dismissedMs: 7 * 86400000 };
  const old = '2026-06-01T00:00:00Z';       // 15 days earlier
  const oneDayAgo = '2026-06-15T00:00:00Z'; // 1 day earlier
  const tenMin = '2026-06-15T23:50:00Z';    // 10 min earlier
  assert.equal(store.prunable({ status: 'pending', createdAt: old }, now, ttl), false);
  assert.equal(store.prunable({ status: 'dismissed', statusAt: old }, now, ttl), true);
  assert.equal(store.prunable({ status: 'dismissed', statusAt: oneDayAgo }, now, ttl), false); // within 7d
  assert.equal(store.prunable({ status: 'launched', statusAt: oneDayAgo }, now, ttl), true);   // past 2h
  assert.equal(store.prunable({ status: 'launched', statusAt: tenMin }, now, ttl), false);     // within 2h
});

// ---- store operations ------------------------------------------------------

test('add returns a pending, fully-shaped candidate', () => {
  fresh();
  const c = store.add({ cwd: '/tmp', skill: 'review-go', prompt: 'check it', reason: 'flaky CI' });
  assert.equal(c.status, 'pending');
  assert.equal(c.action.cwd, '/tmp');
  assert.equal(c.action.skill, 'review-go');
  assert.equal(c.reason, 'flaky CI');
  assert.ok(c.id.startsWith('cand_'));
  assert.ok(c.createdAt);
});

test('add dedupes on dedupeKey while pending (no second item)', () => {
  fresh();
  const a = store.add({ cwd: '/tmp', dedupeKey: 'C1:123' });
  const b = store.add({ cwd: '/tmp', dedupeKey: 'C1:123' });
  assert.equal(a.id, b.id);
  assert.equal(store.pendingCount(), 1);
});

test('add rejects past maxPending (3) with a 429-coded error', () => {
  fresh();
  store.add({ cwd: '/tmp' });
  store.add({ cwd: '/tmp' });
  store.add({ cwd: '/tmp' });
  assert.throws(() => store.add({ cwd: '/tmp' }), (e) => e.status === 429);
});

test('add rejects an invalid skill name', () => {
  fresh();
  assert.throws(() => store.add({ cwd: '/tmp', skill: 'bad name' }), (e) => e.status === 400);
});

test('update edits prompt, skill and priority in place; unknown id returns null', () => {
  fresh();
  const c = store.add({ cwd: '/tmp', prompt: 'old' });
  const u = store.update(c.id, { prompt: 'new', skill: 'debug', priority: 3 });
  assert.equal(u.action.prompt, 'new');
  assert.equal(u.action.skill, 'debug');
  assert.equal(u.priority, 3);
  assert.equal(store.update('nope', { prompt: 'x' }), null);
});

test('launch / dismiss / undismiss transition status', () => {
  fresh();
  const c = store.add({ cwd: '/tmp' });
  assert.equal(store.markLaunched(c.id, 42).status, 'launched');
  assert.equal(store.find(c.id).sessionPid, 42);
  const d = store.add({ cwd: '/tmp' });
  assert.equal(store.dismiss(d.id).status, 'dismissed');
  const u = store.undismiss(d.id);
  assert.equal(u.status, 'pending');
  assert.equal(u.statusAt, undefined);
});

test('remove drops a candidate entirely; unknown id returns false', () => {
  fresh();
  const c = store.add({ cwd: '/tmp' });
  assert.equal(store.remove(c.id), true);
  assert.equal(store.find(c.id), null);
  assert.equal(store.remove('nope'), false);
});

test('list returns the sorted snapshot; pending sorts ahead of launched', () => {
  fresh();
  const a = store.add({ cwd: '/tmp', priority: 1 });
  store.markLaunched(a.id);
  store.add({ cwd: '/tmp', priority: 2 });
  const statuses = store.list().map((c) => c.status);
  assert.equal(statuses[0], 'pending');
  assert.equal(statuses[statuses.length - 1], 'launched');
});

test('candidates persist to disk atomically', () => {
  fresh();
  const c = store.add({ cwd: '/tmp', reason: 'persisted' });
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(onDisk.candidates[0].id, c.id);
  assert.equal(onDisk.candidates[0].reason, 'persisted');
});

test('a corrupt candidates.json degrades to an empty list', () => {
  fresh();
  fs.writeFileSync(FILE, 'not json{');
  store._reset();
  assert.deepEqual(store.list(), []);
});

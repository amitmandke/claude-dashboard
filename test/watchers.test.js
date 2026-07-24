'use strict';

// Throwaway data dir BEFORE requiring anything that reads config, so state/
// candidate files never touch the real ~/.claude-dashboard. node --test gives
// each file its own process, so this env is file-local.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.CLAUDE_DASH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));

const { test } = require('node:test');
const assert = require('node:assert');

const match = require('../server/src/services/watchers/match');
const repos = require('../server/src/services/watchers/repos');
const wconfig = require('../server/src/services/watchers/config');
const state = require('../server/src/services/watchers/state');
const classify = require('../server/src/services/watchers/classify');
const loop = require('../server/src/services/watchers');

// ---- match.js --------------------------------------------------------------

test('mentionsUser: matches <@ID> and <@ID|name>, not other ids or substrings', () => {
  assert.equal(match.mentionsUser('hey <@U123> look', 'U123'), true);
  assert.equal(match.mentionsUser('hey <@U123|amit> look', 'U123'), true);
  assert.equal(match.mentionsUser('hey <@U999> look', 'U123'), false);
  assert.equal(match.mentionsUser('bare U123 no brackets', 'U123'), false);
  assert.equal(match.mentionsUser('', 'U123'), false);
  assert.equal(match.mentionsUser('x', ''), false);
});

test('mentionsAny: true if any listed user is mentioned', () => {
  assert.equal(match.mentionsAny('<@U2>', ['U1', 'U2']), true);
  assert.equal(match.mentionsAny('<@U3>', ['U1', 'U2']), false);
});

test('isNoise: drops subtypes/bots/empty, keeps real messages and thread_broadcast', () => {
  assert.equal(match.isNoise({ text: 'hi' }), false);
  assert.equal(match.isNoise({ text: 'hi', subtype: 'thread_broadcast' }), false);
  assert.equal(match.isNoise({ text: 'x', subtype: 'channel_join' }), true);
  assert.equal(match.isNoise({ text: 'x', bot_id: 'B1' }), true);
  assert.equal(match.isNoise({ text: '   ' }), true);
  assert.equal(match.isNoise({}), true);
});

test('fullText: plain text, and folds in attachment text + title + blocks', () => {
  assert.equal(match.fullText({ text: 'hi' }), 'hi');
  assert.equal(
    match.fullText({ text: '', attachments: [{ text: 'github.com/a/b/pull/3', title: 'PR' }] }),
    'github.com/a/b/pull/3\nPR'
  );
  assert.equal(match.fullText({ attachments: [{ fallback: 'forwarded: see PR' }] }), 'forwarded: see PR');
  assert.equal(match.fullText({ blocks: [{ text: { text: 'block body' } }] }), 'block body');
});

test('isNoise: a forwarded message with only attachment text is NOT noise', () => {
  assert.equal(match.isNoise({ text: '', attachments: [{ text: 'see this' }] }), false);
  assert.equal(match.isNoise({ text: '' }), true);
});

test('threadIdOf: thread_ts when a reply, own ts when top-level', () => {
  assert.equal(match.threadIdOf({ ts: '2', thread_ts: '1' }), '1');
  assert.equal(match.threadIdOf({ ts: '2' }), '2');
});

test('extractPrRefs: pulls owner/repo + number from PR urls (lowercased)', () => {
  const refs = match.extractPrRefs('see https://github.com/Acme/WIDGETS/pull/42 and github.com/a/b/pull/7');
  assert.deepEqual(refs, [
    { repo: 'acme/widgets', number: 42 },
    { repo: 'a/b', number: 7 },
  ]);
  assert.deepEqual(match.extractPrRefs('no links'), []);
});

test('renderThread: oldest-first user: text lines, skips empty', () => {
  const txt = match.renderThread([
    { user: 'U1', text: 'first' },
    { user: 'U2', text: '  ' },
    { user: 'U2', text: 'second' },
  ]);
  assert.equal(txt, 'U1: first\nU2: second');
});

// ---- repos.js --------------------------------------------------------------

test('parseRemoteUrl: ssh + https forms → owner/repo, else null', () => {
  assert.equal(repos.parseRemoteUrl('git@github.com:acme/widgets.git'), 'acme/widgets');
  assert.equal(repos.parseRemoteUrl('https://github.com/acme/widgets'), 'acme/widgets');
  assert.equal(repos.parseRemoteUrl('ssh://git@host/owner/repo.git'), 'owner/repo');
  assert.equal(repos.parseRemoteUrl('not a url'), null);
  assert.equal(repos.parseRemoteUrl(''), null);
});

test('buildMap: discovers checkouts and preferDir wins on duplicates', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-'));
  const mk = (rel, url) => {
    const g = path.join(base, rel, '.git');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  };
  mk('primary/widgets', 'git@github.com:acme/widgets.git');
  mk('scratch/widgets', 'git@github.com:acme/widgets.git');
  mk('solo', 'https://github.com/acme/gadgets.git');

  const m = repos.buildMap(base, { depth: 2, preferDir: 'primary' });
  assert.equal(m.get('acme/widgets'), path.join(base, 'primary', 'widgets'));
  assert.equal(m.get('acme/gadgets'), path.join(base, 'solo'));

  const m2 = repos.buildMap(base, { depth: 2, preferDir: 'scratch' });
  assert.equal(m2.get('acme/widgets'), path.join(base, 'scratch', 'widgets'));
});

test('repos.create.resolve: case-insensitive, null when unknown', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repos2-'));
  const g = path.join(base, 'x', '.git');
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'config'), '[remote "origin"]\n\turl = git@github.com:o/r.git\n');
  const r = repos.create({ base });
  assert.equal(r.resolve('O/R'), path.join(base, 'x'));
  assert.equal(r.resolve('no/thing'), null);
  assert.deepEqual(r.list(), ['o/r']);
});

// ---- config.js -------------------------------------------------------------

test('resolveToken: $VAR from env, literal otherwise, null when missing', () => {
  assert.equal(wconfig.resolveToken('$TOK', { TOK: 'xoxb-1' }), 'xoxb-1');
  assert.equal(wconfig.resolveToken('xoxb-literal', {}), 'xoxb-literal');
  assert.equal(wconfig.resolveToken('$MISSING', {}), null);
  assert.equal(wconfig.resolveToken(undefined, {}), null);
});

test('resolveToken: keychain: scheme reads via the security CLI (service + account)', () => {
  const calls = [];
  const io = { readKeychain: (s, a) => { calls.push([s, a]); return '  xoxb-kc\n'; } };
  assert.equal(wconfig.resolveToken('keychain:my-svc', {}, io), 'xoxb-kc');
  assert.deepEqual(calls[0], ['my-svc', undefined]);
  assert.equal(wconfig.resolveToken('keychain:my-svc:amit', {}, io), 'xoxb-kc');
  assert.deepEqual(calls[1], ['my-svc', 'amit']);
});

test('resolveToken: @file scheme reads + trims; failures fail closed to null', () => {
  assert.equal(wconfig.resolveToken('@/x/tok', {}, { readFile: () => ' xoxb-file \n' }), 'xoxb-file');
  assert.equal(wconfig.resolveToken('@/nope', {}, { readFile: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(wconfig.resolveToken('keychain:missing', {}, { readKeychain: () => { throw new Error('not found'); } }), null);
});

test('normalizeWatcher: fail-closed on empty channels/users; disabled flag', () => {
  assert.equal(wconfig.normalizeWatcher({ channels: ['C1'], users: ['U1'] }, 0).ok, true);
  assert.equal(wconfig.normalizeWatcher({ channels: [], users: ['U1'] }, 0).ok, false);
  assert.equal(wconfig.normalizeWatcher({ channels: ['C1'], users: [] }, 0).ok, false);
  assert.equal(wconfig.normalizeWatcher({ enabled: false, channels: ['C1'], users: ['U1'] }, 0).ok, false);
});

test('normalizeWatcher: dedupes, floors poll interval, accepts mentionUsers alias', () => {
  const n = wconfig.normalizeWatcher(
    { name: 'w', channels: ['C1', 'C1'], mentionUsers: ['U1'], users: ['U1', 'U2'], poll: { everySeconds: 5 } },
    0
  );
  assert.deepEqual(n.channels, ['C1']);
  assert.deepEqual(n.mentionUsers, ['U1', 'U2']);
  assert.equal(n.everySeconds, wconfig.MIN_POLL_SECONDS);
});

test('normalizeTrigger: explicit mention users, legacy fallback, unsupported type', () => {
  assert.deepEqual(wconfig.normalizeTrigger({ trigger: { type: 'mention', users: ['U1'] } }), {
    type: 'mention', users: ['U1'],
  });
  // legacy top-level users still build a mention trigger
  assert.deepEqual(wconfig.normalizeTrigger({ users: ['U9'] }), { type: 'mention', users: ['U9'] });
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'reaction' } }).error, 'unsupported type errors');
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'mention', users: [] } }).error, 'no users errors');
});

test('normalizeTrigger: only mention is supported; unknown types are rejected', () => {
  assert.deepEqual(wconfig.normalizeTrigger({ trigger: { type: 'mention', users: ['U1'] } }), {
    type: 'mention', users: ['U1'],
  });
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'dm', users: ['U1'] } }).error, 'dm no longer supported');
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'mention', users: [] } }).error, 'mention needs users');
});

test('normalizeWatcher: a mention trigger requires channels (fail-closed)', () => {
  assert.equal(wconfig.normalizeWatcher({ name: 'm', trigger: { type: 'mention', users: ['U1'] } }, 0).ok, false);
  const n = wconfig.normalizeWatcher(
    { name: 'm', channels: ['C1'], trigger: { type: 'mention', users: ['U1'] }, intents: [{ name: 'x', skill: 'debug' }] },
    0
  );
  assert.equal(n.ok, true);
  assert.equal(n.trigger.type, 'mention');
  assert.deepEqual(n.channels, ['C1']);
});

test('normalizeWatcher: channels "auto" enables discover mode (no explicit channels needed)', () => {
  const n = wconfig.normalizeWatcher(
    { name: 'a', channels: 'auto', trigger: { type: 'mention', users: ['U1'] } },
    0
  );
  assert.equal(n.ok, true);
  assert.equal(n.discover, true);
  assert.deepEqual(n.channels, []);
  // an explicit list is NOT discover, and an empty list is still fail-closed
  assert.equal(wconfig.normalizeWatcher({ name: 'b', channels: ['C1'], users: ['U1'] }, 0).discover, false);
  assert.equal(wconfig.normalizeWatcher({ name: 'c', channels: [], users: ['U1'] }, 0).ok, false);
});

test('normalizeIntents: keeps valid intent->skill entries, drops malformed', () => {
  const out = wconfig.normalizeIntents({
    intents: [
      { name: 'pr', description: 'review', skill: 'review-java' },
      { name: '', skill: 'x' }, // no name
      { name: 'bad', skill: 'has space' }, // invalid skill
      { name: 'noskill' }, // empty skill is allowed
    ],
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { name: 'pr', description: 'review', skill: 'review-java' });
  assert.equal(out[1].name, 'noskill');
});

test('normalizeWatcher: action.cwd becomes defaultCwd fallback', () => {
  const n = wconfig.normalizeWatcher(
    { name: 'w', channels: ['C1'], trigger: { type: 'mention', users: ['U1'] }, action: { cwd: '/repos/x' } },
    0
  );
  assert.equal(n.defaultCwd, '/repos/x');
  assert.equal(wconfig.normalizeWatcher({ name: 'y', channels: ['C1'], users: ['U1'] }, 0).defaultCwd, '');
});

test('normalizeWatcher: carries trigger + intents through', () => {
  const n = wconfig.normalizeWatcher(
    {
      name: 'w', channels: ['C1'],
      trigger: { type: 'mention', users: ['U1'] },
      intents: [{ name: 'pr', skill: 'review-go' }],
    },
    0
  );
  assert.equal(n.ok, true);
  assert.deepEqual(n.trigger, { type: 'mention', users: ['U1'] });
  assert.deepEqual(n.mentionUsers, ['U1']);
  assert.equal(n.intents[0].skill, 'review-go');
});

test('normalize: splits runnable vs disabled, resolves token', () => {
  const out = wconfig.normalize(
    {
      slack: { botToken: '$TOK' },
      watchers: [
        { name: 'good', channels: ['C1'], users: ['U1'] },
        { name: 'bad', channels: [], users: ['U1'] },
      ],
    },
    { TOK: 'xoxb-9' }
  );
  assert.equal(out.token, 'xoxb-9');
  assert.equal(out.watchers.length, 1);
  assert.equal(out.watchers[0].name, 'good');
  assert.equal(out.disabled[0].name, 'bad');
});

test('setEnabled: flips enabled in the raw file, preserves other fields, matches by derived name', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wcfg-')), 'watchers.json');
  fs.writeFileSync(f, JSON.stringify({
    slack: { botToken: '$T' },
    watchers: [
      { name: 'mentions', enabled: true, channels: ['C1'], trigger: { type: 'mention', users: ['U1'] } },
      { channels: ['C2'], users: ['U2'] }, // no name → derived 'watcher-2'
    ],
  }));
  assert.equal(wconfig.setEnabled('mentions', false, f), true);
  let raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.watchers[0].enabled, false);
  assert.deepEqual(raw.watchers[0].channels, ['C1']); // untouched
  assert.deepEqual(raw.watchers[0].trigger, { type: 'mention', users: ['U1'] });

  assert.equal(wconfig.setEnabled('watcher-2', true, f), true); // derived-name match
  raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.watchers[1].enabled, true);

  assert.equal(wconfig.setEnabled('nope', false, f), false); // no match
  assert.equal(wconfig.setEnabled('mentions', false, '/no/such/file.json'), false); // unreadable
});

// ---- state.js --------------------------------------------------------------

function freshState() {
  try { fs.unlinkSync(state.FILE); } catch {}
  state._reset();
}

// Simulate an ALREADY-running watcher (cursor established) so a single pass
// exercises staging. A pristine first run baselines instead of staging (see the
// dedicated "first run baselines" test), so staging tests must arm a cursor.
function freshArmed() {
  freshState();
  state.advanceCursor('w', 'C1', '1');
}

test('advanceCursor: only moves forward (per channel)', () => {
  freshState();
  assert.equal(state.advanceCursor('w', 'C1', '5.0'), '5.0');
  assert.equal(state.advanceCursor('w', 'C1', '3.0'), '5.0'); // older ignored
  assert.equal(state.advanceCursor('w', 'C1', '9.0'), '9.0');
  assert.equal(state.advanceCursor('w', 'C2', '2.0'), '2.0'); // a different channel is independent
  assert.equal(state.cursorOf('w', 'C1'), '9.0');
});

test('seen: mark + isSeen keyed by channel:thread', () => {
  freshState();
  assert.equal(state.isSeen('w', 'C1', 't1'), false);
  state.markSeen('w', 'C1', 't1', 1000);
  assert.equal(state.isSeen('w', 'C1', 't1'), true);
  assert.equal(state.isSeen('w', 'C1', 't2'), false);
});

test('prune: drops aged threads/seen and caps thread count', () => {
  freshState();
  const now = 10 * 86400000;
  state.trackThread('w', 'C1', 'old', now - 5 * 86400000); // 5d old
  state.trackThread('w', 'C1', 'new', now);
  state.markSeen('w', 'C1', 'oldseen', now - 8 * 86400000); // 8d old
  state.markSeen('w', 'C1', 'newseen', now);
  const r = state.prune('w', {
    nowMs: now,
    threadTtlMs: 3 * 86400000,
    seenTtlMs: 7 * 86400000,
    maxThreads: 50,
  });
  const c = state.forChannel('w', 'C1');
  assert.ok(!c.threads.old && c.threads.new, 'aged thread pruned, fresh kept');
  assert.ok(!state.forWatcher('w').seen['C1:oldseen'] && state.forWatcher('w').seen['C1:newseen'], 'aged seen pruned');
  assert.equal(r.threadsDropped, 1);
  assert.equal(r.seenDropped, 1);
});

test('prune: caps to maxThreads by evicting least-recently-active (per channel)', () => {
  freshState();
  const now = 1000000;
  for (let i = 0; i < 5; i++) state.trackThread('w', 'C1', `t${i}`, now + i); // t0 oldest
  state.prune('w', { nowMs: now + 100, threadTtlMs: 1e12, seenTtlMs: 1e12, maxThreads: 3 });
  const c = state.forChannel('w', 'C1');
  assert.equal(Object.keys(c.threads).length, 3);
  assert.ok(!c.threads.t0 && !c.threads.t1 && c.threads.t4, 'oldest evicted, newest kept');
});

test('setCursor: moves the cursor and clears that channel’s threads + seen only', () => {
  freshState();
  state.advanceCursor('w', 'C1', '5.0');
  state.trackThread('w', 'C1', 't1', 1000);
  state.markSeen('w', 'C1', 't1', 1000);
  state.advanceCursor('w', 'C2', '9.0'); // a sibling channel must be untouched
  state.trackThread('w', 'C2', 't2', 1000);

  state.setCursor('w', 'C1', '100.0', { clearThreads: true });
  assert.equal(state.cursorOf('w', 'C1'), '100.0');       // moved forward past the gap
  assert.deepEqual(state.forChannel('w', 'C1').threads, {}); // C1 threads cleared
  assert.equal(state.isSeen('w', 'C1', 't1'), false);      // C1 seen cleared
  assert.equal(state.cursorOf('w', 'C2'), '9.0');          // C2 cursor intact
  assert.ok(state.forChannel('w', 'C2').threads.t2, 'C2 threads intact');
});

test('channel name cache: setChannelName / channelNameOf, no create on read', () => {
  freshState();
  assert.equal(state.channelNameOf('w', 'C1'), null);
  state.setChannelName('w', 'C1', '#eng-prov');
  assert.equal(state.channelNameOf('w', 'C1'), '#eng-prov');
  assert.equal(state.cursorOf('w', 'never'), null); // reading an unknown channel doesn't throw/create
});

// ---- classify.js -----------------------------------------------------------

test('parseResult: parses a clean object and clamps/validates fields', () => {
  const r = classify.parseResult(
    '{"actionable":true,"repo":"A/B","skill":"review-go","prompt":" do it ","reason":"r","confidence":1.5}'
  );
  assert.equal(r.actionable, true);
  assert.equal(r.repo, 'a/b');
  assert.equal(r.skill, 'review-go');
  assert.equal(r.prompt, 'do it');
  assert.equal(r.confidence, 1); // clamped to 1
});

test('parseResult: tolerates code fences and surrounding prose; rejects bad skill', () => {
  const r = classify.parseResult('Here:\n```json\n{"actionable":false,"skill":"bad name"}\n```\nthanks');
  assert.equal(r.actionable, false);
  assert.equal(r.skill, ''); // "bad name" fails the skill-name shape
});

test('parseResult: extracts intent name (intent mode)', () => {
  const r = classify.parseResult('{"intent":"pr-review","confidence":0.9}');
  assert.equal(r.intent, 'pr-review');
  assert.equal(r.confidence, 0.9);
  assert.equal(classify.parseResult('{"intent":null}').intent, null);
});

test('buildPrompt: intent mode lists intents and asks only for intent+confidence', () => {
  const p = classify.buildPrompt({
    threadText: 't', intents: [{ name: 'pr-review', description: 'review a PR' }],
  });
  assert.match(p, /pr-review: review a PR/);
  assert.match(p, /"intent".*"confidence"/s);
  assert.doesNotMatch(p, /"skill"/); // the model does not pick a skill in intent mode
});

test('parseResult: null on non-JSON', () => {
  assert.equal(classify.parseResult('no json here'), null);
  assert.equal(classify.parseResult(''), null);
});

test('fallbackPlan: stages unclassified, uses first PR ref as repo hint', () => {
  const p = classify.fallbackPlan({ threadText: 'help me', prRefs: [{ repo: 'a/b', number: 1 }] });
  assert.equal(p.actionable, true);
  assert.equal(p.repo, 'a/b');
  assert.equal(p.unclassified, true);
});

test('classify: returns parsed plan from injected runner', async () => {
  const plan = await classify.classify(
    { threadText: 't', prRefs: [], repos: [], skills: [] },
    { _run: async () => '{"actionable":true,"repo":"a/b","prompt":"x","confidence":0.7}' }
  );
  assert.equal(plan.repo, 'a/b');
  assert.equal(plan.confidence, 0.7);
});

test('classify: falls back when the runner throws', async () => {
  const plan = await classify.classify(
    { threadText: 'help', prRefs: [] },
    { _run: async () => { throw new Error('boom'); } }
  );
  assert.equal(plan.unclassified, true);
});

// ---- index.js (runWatcherOnce) --------------------------------------------

const WATCHER = { name: 'w', channels: ['C1'], mentionUsers: ['U1'], everySeconds: 120 };
const RETENTION = { threadTtlMs: 3 * 86400000, seenTtlMs: 7 * 86400000, maxThreads: 50 };

function stubClient({ history = [], repliesByTs = {} }) {
  return {
    async history() { return { messages: history, has_more: false }; },
    async replies({ ts, oldest }) {
      const all = repliesByTs[ts] || [];
      const msgs = oldest ? all.filter((m) => parseFloat(m.ts) > parseFloat(oldest)) : all;
      return { messages: msgs, has_more: false };
    },
    async permalink() { return { permalink: 'https://slack/x' }; },
    async info({ channel }) { return { channel: { id: channel, name: `chan-${channel}` } }; },
  };
}

function fakeCandidates() {
  return { added: [], add(x) { this.added.push(x); return { id: 'cand_' + this.added.length }; } };
}

const alwaysActionable = async () => ({
  actionable: true, repo: 'acme/widgets', skill: 'review-go', prompt: 'review it', reason: 'PR for you', confidence: 0.9,
});

test('runWatcherOnce: first run (no cursor) baselines to NOW — stages nothing, fetches nothing', async () => {
  freshState(); // NO armed cursor → this is a pristine first run
  const candidates = fakeCandidates();
  let historyCalls = 0;
  const client = {
    async history() { historyCalls++; return { messages: [{ ts: '100.1', text: '<@U1> please review' }], has_more: false }; },
    async replies() { return { messages: [], has_more: false }; },
    async permalink() { return { permalink: '' }; },
    async info({ channel }) { return { channel: { name: `chan-${channel}` } }; },
  };
  const r = await loop.runWatcherOnce(WATCHER, {
    client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1700000000000,
  });
  assert.equal(r.staged, 0, 'no backlog staged on first run');
  assert.equal(candidates.added.length, 0);
  assert.equal(historyCalls, 0, 'first sight fetches no history — instant baseline');
  assert.equal(state.cursorOf('w', 'C1'), '1700000000.000000', 'cursor baselined to NOW, not the newest message');
});

test('watching-since is fixed at baseline while the cursor advances with new messages', async () => {
  freshState();
  const candidates = fakeCandidates();
  const msgs = [];
  const client = {
    async history({ oldest }) {
      return { messages: oldest ? msgs.filter((m) => parseFloat(m.ts) > parseFloat(oldest)) : msgs, has_more: false };
    },
    async replies() { return { messages: [], has_more: false }; },
    async permalink() { return { permalink: '' }; },
    async info({ channel }) { return { channel: { name: `c-${channel}` } }; },
  };
  const W = { name: 'w', channels: ['C1'], mentionUsers: ['U1'], everySeconds: 120 };
  // first sight → baseline sets BOTH since and cursor to now
  await loop.runWatcherOnce(W, { client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1700000000000 });
  assert.equal(state.sinceOf('w', 'C1'), '1700000000.000000');
  assert.equal(state.cursorOf('w', 'C1'), '1700000000.000000');
  // a later message advances the cursor but the displayed "since" stays put
  msgs.push({ ts: '1700000500.0', text: 'hi <@U1>' });
  await loop.runWatcherOnce(W, { client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1700000600000 });
  assert.equal(state.cursorOf('w', 'C1'), '1700000500.0', 'cursor advances to the new message');
  assert.equal(state.sinceOf('w', 'C1'), '1700000000.000000', 'watching-since is unchanged');
});

test('runWatcherOnce: a top-level mention stages one candidate with resolved cwd', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const client = stubClient({
    history: [{ ts: '100.1', text: 'hey <@U1> review github.com/acme/widgets/pull/9' }],
    repliesByTs: { '100.1': [{ ts: '100.1', user: 'U2', text: 'hey <@U1> review this' }] },
  });
  const r = await loop.runWatcherOnce(WATCHER, {
    client, candidates, classify: alwaysActionable,
    resolveRepo: (rr) => (rr === 'acme/widgets' ? '/local/widgets' : null),
    knownRepos: ['acme/widgets'], retention: RETENTION, nowMs: 1000,
  });
  assert.equal(r.staged, 1);
  assert.equal(candidates.added.length, 1);
  const c = candidates.added[0];
  assert.equal(c.cwd, '/local/widgets');
  assert.equal(c.source, 'slack');
  assert.equal(c.producer, 'watcher');
  assert.equal(c.dedupeKey, 'C1:100.1');
  assert.equal(c.ref, 'https://slack/x');
  assert.equal(c.priority, 2); // confidence 0.9
});

test('runWatcherOnce: dedupes — a second pass does not re-stage the same thread', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const opts = {
    client: stubClient({ history: [{ ts: '100.1', text: 'yo <@U1>' }] }),
    candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  };
  await loop.runWatcherOnce(WATCHER, opts);
  await loop.runWatcherOnce(WATCHER, { ...opts, nowMs: 2000 });
  assert.equal(candidates.added.length, 1);
});

test('runWatcherOnce: catches a mention that arrives as a late thread reply', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  // root has NO mention; a later reply mentions U1
  const client = stubClient({
    history: [{ ts: '50.0', text: 'starting a thread', reply_count: 1 }],
    repliesByTs: { '50.0': [
      { ts: '50.0', user: 'U2', text: 'starting a thread' },
      { ts: '55.0', user: 'U3', text: 'cc <@U1> can you look' },
    ] },
  });
  const r = await loop.runWatcherOnce(WATCHER, {
    client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.equal(r.staged, 1);
  assert.equal(candidates.added[0].dedupeKey, 'C1:50.0');
});

test('runWatcherOnce: not-actionable thread is marked seen but not staged', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const client = stubClient({ history: [{ ts: '100.1', text: 'thanks <@U1>!' }] });
  const r = await loop.runWatcherOnce(WATCHER, {
    client, candidates, classify: async () => ({ actionable: false }), resolveRepo: () => '/x',
    retention: RETENTION, nowMs: 1000,
  });
  assert.equal(r.staged, 0);
  assert.equal(candidates.added.length, 0);
  assert.equal(state.isSeen('w', 'C1', '100.1'), true); // won't be reclassified next tick
});

test('runWatcherOnce: no mention → nothing staged but cursor advances', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const client = stubClient({ history: [{ ts: '77.0', text: 'unrelated chatter' }] });
  const r = await loop.runWatcherOnce(WATCHER, {
    client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.equal(r.staged, 0);
  assert.equal(state.cursorOf('w', 'C1'), '77.0');
});

// --- intent mode: the LLM only names an intent; skill/repo/prompt are derived ---

const INTENT_WATCHER = {
  name: 'w', channels: ['C1'], mentionUsers: ['U1'], everySeconds: 120,
  intents: [
    { name: 'pr-review', description: 'review a PR', skill: 'review-java' },
    { name: 'bug', description: 'a bug', skill: 'debug' },
  ],
};

test('runWatcherOnce: intent match → skill from config map, deterministic prompt', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const client = stubClient({
    history: [{ ts: '100.1', text: 'hey <@U1> review github.com/acme/widgets/pull/9' }],
    repliesByTs: { '100.1': [{ ts: '100.1', user: 'U2', text: 'hey <@U1> review github.com/acme/widgets/pull/9' }] },
  });
  const r = await loop.runWatcherOnce(INTENT_WATCHER, {
    client, candidates,
    classify: async () => ({ intent: 'pr-review', confidence: 0.9 }), // model names intent only
    resolveRepo: (rr) => (rr === 'acme/widgets' ? '/local/widgets' : null),
    retention: RETENTION, nowMs: 1000,
  });
  assert.equal(r.staged, 1);
  const c = candidates.added[0];
  assert.equal(c.skill, 'review-java'); // from the intent->skill map, not the model
  assert.equal(c.cwd, '/local/widgets'); // resolved from the PR link, not the model
  assert.match(c.prompt, /Slack thread:/); // deterministic prompt, not model-authored
  assert.match(c.prompt, /acme\/widgets#9/);
  assert.match(c.reason, /matched intent "pr-review"/);
});

test('runWatcherOnce: intent mode — no matching intent is not staged', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const client = stubClient({ history: [{ ts: '100.1', text: 'yo <@U1>' }] });
  const r = await loop.runWatcherOnce(INTENT_WATCHER, {
    client, candidates,
    classify: async () => ({ intent: 'something-else', confidence: 0.9 }), // not in the map
    resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.equal(r.staged, 0);
  assert.equal(candidates.added.length, 0);
  assert.equal(state.isSeen('w', 'C1', '100.1'), true);
});

test('runWatcherOnce: falls back to watcher.defaultCwd when no repo resolves', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const client = stubClient({ history: [{ ts: '100.1', text: 'yo <@U1> take a look' }] });
  const r = await loop.runWatcherOnce(
    { ...WATCHER, defaultCwd: '/repos/fallback' },
    { client, candidates, classify: alwaysActionable, resolveRepo: () => null, retention: RETENTION, nowMs: 1000 }
  );
  assert.equal(r.staged, 1);
  assert.equal(candidates.added[0].cwd, '/repos/fallback'); // no PR link → default target folder
  assert.doesNotMatch(candidates.added[0].reason, /pick a repo/); // has a cwd now
});

test('runWatcherOnce: empty cwd when repo cannot be resolved, flagged in reason', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const client = stubClient({ history: [{ ts: '100.1', text: 'yo <@U1>' }] });
  await loop.runWatcherOnce(WATCHER, {
    client, candidates, classify: alwaysActionable, resolveRepo: () => null, retention: RETENTION, nowMs: 1000,
  });
  assert.equal(candidates.added[0].cwd, '');
  assert.match(candidates.added[0].reason, /pick a repo/);
});

test('runWatcherOnce: scans all configured channels, each with its own cursor', async () => {
  freshState();
  // arm both channels so this is a steady-state pass (not a baseline run)
  state.advanceCursor('w', 'C1', '1');
  state.advanceCursor('w', 'C2', '1');
  const candidates = fakeCandidates();
  const byChannel = {
    C1: [{ ts: '100.1', user: 'U9', text: 'hey <@U1> review github.com/acme/widgets/pull/1' }],
    C2: [{ ts: '200.1', user: 'U9', text: 'and <@U1> this github.com/acme/widgets/pull/2' }],
  };
  const client = {
    async history({ channel }) { return { messages: byChannel[channel] || [], has_more: false }; },
    async replies({ ts }) { return { messages: (Object.values(byChannel).flat().find((m) => m.ts === ts) ? [] : []), has_more: false }; },
    async permalink() { return { permalink: 'https://slack/x' }; },
    async info({ channel }) { return { channel: { name: `chan-${channel}` } }; },
  };
  const r = await loop.runWatcherOnce(
    { name: 'w', channels: ['C1', 'C2'], mentionUsers: ['U1'], everySeconds: 120 },
    { client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000 }
  );
  assert.equal(r.staged, 2, 'one candidate from each channel');
  assert.equal(state.cursorOf('w', 'C1'), '100.1');
  assert.equal(state.cursorOf('w', 'C2'), '200.1');
  assert.equal(state.channelNameOf('w', 'C1'), '#chan-C1'); // name resolved + cached
});

test('runWatcherOnce: discover mode scans every channel the bot is a member of', async () => {
  freshState();
  const candidates = fakeCandidates();
  const byChannel = {
    C1: [{ ts: '100.1', user: 'U9', text: 'hey <@U1> review github.com/acme/widgets/pull/1' }],
    C2: [{ ts: '200.1', user: 'U9', text: 'nothing to see here' }],
  };
  const client = {
    async userConversations() { return { channels: [{ id: 'C1' }, { id: 'C2' }] }; },
    async history({ channel, oldest }) {
      const all = byChannel[channel] || [];
      const msgs = oldest ? all.filter((m) => parseFloat(m.ts) > parseFloat(oldest)) : all;
      return { messages: msgs, has_more: false };
    },
    async replies() { return { messages: [], has_more: false }; },
    async permalink() { return { permalink: 'https://slack/x' }; },
    async info({ channel }) { return { channel: { name: `chan-${channel}` } }; },
  };
  // first pass over each discovered channel baselines to now (stages nothing)…
  await loop.runWatcherOnce(
    { name: 'w', discover: true, channels: [], mentionUsers: ['U1'], everySeconds: 120 },
    { client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 300000 }
  );
  assert.equal(candidates.added.length, 0, 'discovered channels baseline first');
  assert.deepEqual(state.channelsOf('w').sort(), ['C1', 'C2']); // both are now tracked

  // …a later pass with a fresh mention (after the baseline) stages it
  byChannel.C1.push({ ts: '400.1', user: 'U9', text: 'and <@U1> this github.com/acme/widgets/pull/3' });
  const r = await loop.runWatcherOnce(
    { name: 'w', discover: true, channels: [], mentionUsers: ['U1'], everySeconds: 120 },
    { client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 500000 }
  );
  assert.equal(r.staged, 1);
  assert.equal(candidates.added[0].dedupeKey, 'C1:400.1');
});

test('runWatcherOnce: discover falls back to public-only when groups:read is missing', async () => {
  freshState();
  const candidates = fakeCandidates();
  const calls = [];
  const client = {
    async userConversations({ types }) {
      calls.push(types);
      if (types.includes('private_channel')) { const e = new Error('slack users.conversations: missing_scope'); throw e; }
      return { channels: [{ id: 'C1' }] };
    },
    async history() { return { messages: [], has_more: false }; },
    async replies() { return { messages: [], has_more: false }; },
    async permalink() { return { permalink: '' }; },
    async info({ channel }) { return { channel: { name: `chan-${channel}` } }; },
  };
  await loop.runWatcherOnce(
    { name: 'w', discover: true, channels: [], mentionUsers: ['U1'], everySeconds: 120 },
    { client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000 }
  );
  assert.deepEqual(calls, ['public_channel,private_channel', 'public_channel']); // tried both, degraded
  assert.deepEqual(state.channelsOf('w'), ['C1']); // still discovered the public channel
});

test('runWatcherOnce: a paused channel is skipped (others still scanned)', async () => {
  freshState();
  ['C1', 'C2'].forEach((c) => { state.advanceCursor('w', c, '1'); state.setSince('w', c, '1'); });
  state.setPaused('w', 'C2', true);
  const candidates = fakeCandidates();
  const byChannel = {
    C1: [{ ts: '100.1', user: 'U9', text: '<@U1> review github.com/acme/widgets/pull/1' }],
    C2: [{ ts: '200.1', user: 'U9', text: '<@U1> review github.com/acme/widgets/pull/2' }],
  };
  const client = {
    async history({ channel, oldest }) {
      const all = byChannel[channel] || [];
      return { messages: oldest ? all.filter((m) => parseFloat(m.ts) > parseFloat(oldest)) : all, has_more: false };
    },
    async replies() { return { messages: [], has_more: false }; },
    async permalink() { return { permalink: '' }; },
    async info({ channel }) { return { channel: { name: channel } }; },
  };
  const r = await loop.runWatcherOnce(
    { name: 'w', channels: ['C1', 'C2'], mentionUsers: ['U1'], everySeconds: 120 },
    { client, candidates, classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000 }
  );
  assert.equal(r.staged, 1, 'only the active channel staged');
  assert.equal(candidates.added[0].dedupeKey, 'C1:100.1');
});

// --- watcher controls: pause/resume/run-now/stop-all/start-all ---

test('watcher controls: start → pause (persists) → resume → run-now, with a fake client', async () => {
  // a real config file in the temp data dir + a token via env
  const cfgFile = wconfig.FILE;
  process.env.WATCH_TEST_TOK = 'xoxb-test';
  fs.writeFileSync(cfgFile, JSON.stringify({
    slack: { botToken: '$WATCH_TEST_TOK' },
    watchers: [{ name: 'mentions', enabled: true, channels: ['C1'],
      trigger: { type: 'mention', users: ['U1'] }, intents: [], poll: { everySeconds: 120 } }],
  }));
  freshState();
  loop._reset();
  const fakeClient = {
    history: async () => ({ messages: [], has_more: false }),
    replies: async () => ({ messages: [], has_more: false }),
    permalink: async () => ({ permalink: '' }),
  };
  loop._setTestHooks({
    buildDeps: () => ({ client: fakeClient, repoMap: { resolve: () => null, list: () => [] },
      skillList: [], retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 10 } }),
    scheduleInterval: () => ({}), // no real interval
  });

  loop.start();
  let st = loop.getStatus();
  assert.equal(st.enabled, true);
  const running = () => loop.getStatus().watchers.find((w) => w.name === 'mentions').state;
  assert.equal(running(), 'running');

  // pause → paused + persisted to the file
  const p = loop.pause('mentions');
  assert.equal(p.ok, true);
  assert.equal(p.persisted, true);
  assert.equal(running(), 'paused');
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).watchers[0].enabled, false);

  // resume → running + re-enabled in the file
  const r = loop.resume('mentions');
  assert.equal(r.ok, true);
  assert.equal(running(), 'running');
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).watchers[0].enabled, true);

  // run-now works on a live watcher
  const rn = await loop.runNow('mentions');
  assert.equal(rn.ok, true);

  // set-cursor moves a channel's "watching since" and is reflected in status
  const sc = loop.setChannelCursor('mentions', 'C1', '2026-01-02T03:04:05.000Z');
  assert.equal(sc.ok, true);
  assert.equal(sc.watchingSince, '2026-01-02T03:04:05.000Z');
  const chan = loop.getStatus().watchers.find((w) => w.name === 'mentions').channels.find((c) => c.id === 'C1');
  assert.equal(chan.watchingSince, '2026-01-02T03:04:05.000Z');
  // "now" and unknown channel/watcher are handled
  assert.equal(loop.setChannelCursor('mentions', 'C1', 'now').ok, true);
  assert.equal(loop.setChannelCursor('mentions', 'C-nope', 'now').ok, false);
  assert.equal(loop.setChannelCursor('ghost', 'C1', 'now').ok, false);

  // per-channel pause persists into status; unknown channel/watcher rejected
  assert.equal(loop.setChannelPaused('mentions', 'C1', true).ok, true);
  const c1 = loop.getStatus().watchers.find((w) => w.name === 'mentions').channels.find((c) => c.id === 'C1');
  assert.equal(c1.paused, true);
  assert.equal(loop.setChannelPaused('mentions', 'C1', false).ok, true);
  assert.equal(loop.setChannelPaused('mentions', 'C-nope', true).ok, false);
  assert.equal(loop.setChannelPaused('ghost', 'C1', true).ok, false);

  // stop-all → paused; start-all → running
  loop.stopAll();
  assert.equal(running(), 'paused');
  loop.startAll();
  assert.equal(running(), 'running');

  loop.stop();
  fs.unlinkSync(cfgFile);
  delete process.env.WATCH_TEST_TOK;
});

test('watcher controls: pause/resume/run-now on an unknown watcher fail cleanly', async () => {
  loop._reset();
  assert.equal(loop.pause('ghost').ok, false);
  assert.equal(loop.resume('ghost').ok, false);
  assert.equal((await loop.runNow('ghost')).ok, false);
});

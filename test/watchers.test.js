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
const slack = require('../server/src/services/watchers/slack');
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

// A v1 `mention` trigger normalizes to the v2 `slack` shape (`users` stays as an
// alias of `mentions` for the shipped runner).
const slackTrigger = (mentions, extra = {}) => ({
  type: 'slack', botRef: 'default', mentions, users: mentions, channels: [], discover: false,
  excludeChannels: [], ...extra,
});

test('normalizeTrigger: excludeChannels is deduped, defaults empty, survives auto', () => {
  assert.deepEqual(
    wconfig.normalizeTrigger({
      trigger: { type: 'slack', mentions: ['U1'], channels: 'auto', excludeChannels: ['C2', 'C2', 'C3'] },
    }),
    slackTrigger(['U1'], { discover: true, excludeChannels: ['C2', 'C3'] })
  );
  // the denylist is the whole point of auto, so it must not require an explicit list
  assert.deepEqual(
    wconfig.normalizeTrigger({ trigger: { type: 'slack', mentions: ['U1'], channels: 'auto' } }).excludeChannels,
    []
  );
});

test('normalizeWatcher: an explicit list fully excluded fails closed', () => {
  const w = wconfig.normalizeWatcher(
    {
      name: 'w', enabled: true,
      trigger: { type: 'slack', mentions: ['U1'], channels: ['C1', 'C2'], excludeChannels: ['C1', 'C2'] },
    },
    0
  );
  assert.equal(w.ok, false);
  assert.match(w.reason, /every channel is excluded/);
  // excluding only SOME of them is fine
  const ok = wconfig.normalizeWatcher(
    {
      name: 'w', enabled: true,
      trigger: { type: 'slack', mentions: ['U1'], channels: ['C1', 'C2'], excludeChannels: ['C2'] },
    },
    0
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.excludeChannels, ['C2']);
  // and `auto` + a denylist is never fail-closed: discovery may still find others
  const auto = wconfig.normalizeWatcher(
    {
      name: 'w', enabled: true,
      trigger: { type: 'slack', mentions: ['U1'], channels: 'auto', excludeChannels: ['C1'] },
    },
    0
  );
  assert.equal(auto.ok, true);
});

test('normalizeTrigger: explicit mention users, legacy fallback, unsupported type', () => {
  assert.deepEqual(
    wconfig.normalizeTrigger({ trigger: { type: 'mention', users: ['U1'] } }),
    slackTrigger(['U1'])
  );
  // legacy top-level users still build a slack trigger
  assert.deepEqual(wconfig.normalizeTrigger({ users: ['U9'] }), slackTrigger(['U9']));
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'reaction' } }).error, 'unsupported type errors');
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'mention', users: [] } }).error, 'no users errors');
});

test('normalizeTrigger: slack + schedule are supported; unknown types are rejected', () => {
  assert.deepEqual(
    wconfig.normalizeTrigger({ trigger: { type: 'slack', mentions: ['U1'] } }),
    slackTrigger(['U1'])
  );
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'dm', users: ['U1'] } }).error, 'dm no longer supported');
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'mention', users: [] } }).error, 'mention needs users');
});

test('normalizeTrigger: schedule needs an interval/time/cron and a valid HH:MM', () => {
  assert.deepEqual(wconfig.normalizeTrigger({ trigger: { type: 'schedule', everyMinutes: 30 } }), {
    type: 'schedule', everyMinutes: 30, at: '', cron: '',
  });
  // `at` alone means daily
  assert.deepEqual(wconfig.normalizeTrigger({ trigger: { type: 'schedule', at: '09:00' } }), {
    type: 'schedule', everyMinutes: 1440, at: '09:00', cron: '',
  });
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'schedule' } }).error, 'needs one of the three');
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'schedule', at: '9am' } }).error, 'bad time errors');
  assert.ok(wconfig.normalizeTrigger({ trigger: { type: 'schedule', at: '24:00' } }).error, 'out-of-range time errors');
});

test('normalizeTrigger: explicit botRef and channel list carry through', () => {
  const t = wconfig.normalizeTrigger({
    trigger: { type: 'slack', botRef: 'work', mentions: ['U1'], channels: ['C1', 'C1', 'C2'] },
  });
  assert.equal(t.botRef, 'work');
  assert.deepEqual(t.channels, ['C1', 'C2']);
});

test('normalizeWatcher: a slack trigger requires channels (fail-closed)', () => {
  assert.equal(wconfig.normalizeWatcher({ name: 'm', trigger: { type: 'mention', users: ['U1'] } }, 0).ok, false);
  const n = wconfig.normalizeWatcher(
    { name: 'm', channels: ['C1'], trigger: { type: 'mention', users: ['U1'] }, intents: [{ name: 'x', skill: 'debug' }] },
    0
  );
  assert.equal(n.ok, true);
  assert.equal(n.trigger.type, 'slack');
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
  assert.deepEqual(n.trigger, slackTrigger(['U1'], { channels: ['C1'] }));
  assert.deepEqual(n.mentionUsers, ['U1']);
  assert.equal(n.intents[0].skill, 'review-go');
  // and the same watcher in v2 terms
  assert.deepEqual(n.rules, [{ name: 'pr', about: '', action: { type: 'skill', skill: 'review-go' } }]);
});

// ---- schema v2: migration, bots, rules, schedule watchers ------------------

test('migrateRaw: v1 file upgrades losslessly and is idempotent', () => {
  const v1 = {
    slack: { botToken: '$SLACK_BOT_TOKEN' },
    watchers: [{
      name: 'mentions',
      enabled: true,
      channels: 'auto',
      trigger: { type: 'mention', users: ['U1'] },
      intents: [{ name: 'pr', description: 'review a PR', skill: 'review-go' }],
      poll: { everySeconds: 120 },
      action: { preferCheckout: 'acme', cwd: '/repos/x' },
    }],
  };
  const frozen = JSON.parse(JSON.stringify(v1));
  const v2 = wconfig.migrateRaw(v1);

  assert.equal(v2.version, 2);
  assert.deepEqual(v2.slack, { bots: { default: { token: '$SLACK_BOT_TOKEN' } } });
  const w = v2.watchers[0];
  assert.deepEqual(w.trigger, {
    type: 'slack', botRef: 'default', mentions: ['U1'], channels: 'auto',
  });
  assert.deepEqual(w.rules, [
    { name: 'pr', about: 'review a PR', action: { type: 'skill', skill: 'review-go' } },
  ]);
  assert.equal(w.intents, undefined, 'v1 intents are consumed');
  assert.equal(w.channels, undefined, 'channels moved under trigger');
  // untouched blocks ride along
  assert.deepEqual(w.poll, { everySeconds: 120 });
  assert.deepEqual(w.action, { preferCheckout: 'acme', cwd: '/repos/x' });
  assert.equal(w.name, 'mentions');
  assert.equal(w.enabled, true);

  assert.deepEqual(v1, frozen, 'input is not mutated');
  assert.deepEqual(wconfig.migrateRaw(v2), v2, 'idempotent');
});

test('migrateRaw: keeps comment keys, an explicit bots map, and a v2 watcher as-is', () => {
  const v2in = {
    version: 2,
    '//note': 'kept',
    slack: { bots: { work: { token: 'keychain:dash-slack', label: 'dash-bot' } } },
    watchers: [{
      name: 'w',
      trigger: { type: 'slack', botRef: 'work', mentions: ['U1'], channels: ['C1'] },
      rules: [{ name: 'r', about: 'x', action: { type: 'prompt', prompt: 'do it' } }],
    }],
  };
  assert.deepEqual(wconfig.migrateRaw(v2in), v2in);
});

test('migrateRaw: a v1 botToken does not clobber an existing default bot', () => {
  const out = wconfig.migrateRaw({
    slack: { botToken: '$OLD', bots: { default: { token: '$NEW' } } },
  });
  assert.deepEqual(out.slack, { bots: { default: { token: '$NEW' } } });
});

test('normalizeBots: resolves each bot, exposes the ref not the secret, skips junk', () => {
  const bots = wconfig.normalizeBots(
    {
      slack: {
        bots: {
          default: { token: '$TOK', label: 'dash-bot' },
          shorthand: 'keychain:svc',
          missing: { token: '$NOPE' },
          'bad ref': { token: '$TOK' },
          empty: 42,
        },
      },
    },
    { TOK: 'xoxb-1' },
    { readKeychain: () => 'xoxb-2' }
  );
  assert.deepEqual(Object.keys(bots).sort(), ['default', 'missing', 'shorthand']);
  assert.equal(bots.default.token, 'xoxb-1');
  assert.equal(bots.default.tokenRef, '$TOK');
  assert.equal(bots.default.label, 'dash-bot');
  assert.equal(bots.shorthand.token, 'xoxb-2', 'a bare string is a token ref');
  assert.equal(bots.missing.token, null, 'unresolvable token fails closed');
});

test('normalize: v1 file yields the same runnable watcher as its v2 equivalent', () => {
  const v1 = wconfig.normalize(
    {
      slack: { botToken: '$TOK' },
      watchers: [{
        name: 'mentions', channels: ['C1'], trigger: { type: 'mention', users: ['U1'] },
        intents: [{ name: 'pr', description: 'a PR', skill: 'review-go' }],
      }],
    },
    { TOK: 'xoxb-9' }
  );
  const v2 = wconfig.normalize(
    {
      version: 2,
      slack: { bots: { default: { token: '$TOK' } } },
      watchers: [{
        name: 'mentions',
        trigger: { type: 'slack', botRef: 'default', mentions: ['U1'], channels: ['C1'] },
        rules: [{ name: 'pr', about: 'a PR', action: { type: 'skill', skill: 'review-go' } }],
      }],
    },
    { TOK: 'xoxb-9' }
  );
  assert.deepEqual(v1.watchers, v2.watchers, 'round-trip parity');
  assert.equal(v1.version, 2);
  assert.equal(v1.watchers[0].token, 'xoxb-9', 'watcher carries its bot token');
  assert.equal(v1.watchers[0].botRef, 'default');
});

test('normalize: a watcher picks up its own bot; an unknown ref gets no token', () => {
  const out = wconfig.normalize(
    {
      version: 2,
      slack: { bots: { work: { token: '$W', label: 'work-bot' }, home: { token: '$H' } } },
      watchers: [
        { name: 'a', trigger: { type: 'slack', botRef: 'home', mentions: ['U1'], channels: ['C1'] } },
        { name: 'b', trigger: { type: 'slack', botRef: 'ghost', mentions: ['U1'], channels: ['C1'] } },
      ],
    },
    { W: 'xoxb-w', H: 'xoxb-h' }
  );
  assert.equal(out.watchers[0].token, 'xoxb-h');
  assert.equal(out.watchers[1].token, null, 'unknown botRef fails closed');
  // no `default` bot → the first one is the legacy single-token fallback
  assert.equal(out.token, 'xoxb-w');
});

test('normalizeRules: skill + prompt actions, drops malformed', () => {
  const out = wconfig.normalizeRules({
    rules: [
      { name: 'a', about: 'x', action: { type: 'skill', skill: 'review-go' } },
      { name: 'b', action: { type: 'prompt', prompt: 'go find it' } },
      { name: 'c' },                                              // no action → empty skill, allowed
      { name: '', action: { type: 'skill', skill: 'x' } },         // no name
      { name: 'd', action: { type: 'skill', skill: 'has space' } }, // invalid skill
      { name: 'e', action: { type: 'prompt', prompt: '' } },        // empty prompt
      { name: 'f', action: { type: 'launch' } },                    // unknown action
    ],
  });
  assert.deepEqual(out.map((r) => r.name), ['a', 'b', 'c']);
  assert.deepEqual(out[1].action, { type: 'prompt', prompt: 'go find it' });
  assert.deepEqual(out[2].action, { type: 'skill', skill: '' });
});

test('rulesToIntents: prompt rules map to an empty skill (runner has no prompt action yet)', () => {
  const intents = wconfig.rulesToIntents([
    { name: 'a', about: 'x', action: { type: 'skill', skill: 'debug' } },
    { name: 'b', about: 'y', action: { type: 'prompt', prompt: 'go' } },
  ]);
  assert.deepEqual(intents, [
    { name: 'a', description: 'x', skill: 'debug' },
    { name: 'b', description: 'y', skill: '' },
  ]);
});

test('normalizeWatcher: a schedule watcher validates its prompt and schedule', () => {
  const n = wconfig.normalizeWatcher(
    {
      name: 'sweep',
      trigger: { type: 'schedule', everyMinutes: 1440, at: '09:00' },
      prompt: '  Check my review-requested PRs  ',
      action: { preferCheckout: 'acme', cwd: '/repos' },
    },
    0
  );
  assert.equal(n.ok, true);
  assert.equal(n.type, 'schedule');
  assert.equal(n.prompt, 'Check my review-requested PRs');
  assert.equal(n.everyMinutes, 1440);
  assert.equal(n.at, '09:00');
  assert.equal(n.defaultCwd, '/repos');
  assert.equal(n.preferCheckout, 'acme');
  // no prompt → fail-closed
  const bad = wconfig.normalizeWatcher({ name: 's2', trigger: { type: 'schedule', everyMinutes: 10 } }, 0);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /prompt/);
});

test('normalize: schedule watchers are kept + reported, never handed to the Slack loop', () => {
  const out = wconfig.normalize(
    {
      version: 2,
      slack: { bots: { default: { token: '$TOK' } } },
      watchers: [
        { name: 'slack-one', trigger: { type: 'slack', mentions: ['U1'], channels: ['C1'] } },
        { name: 'sweep', trigger: { type: 'schedule', everyMinutes: 60 }, prompt: 'find work' },
      ],
    },
    { TOK: 'xoxb-9' }
  );
  assert.deepEqual(out.watchers.map((w) => w.name), ['slack-one'], 'only slack watchers run');
  assert.equal(out.disabled.length, 1);
  assert.equal(out.disabled[0].name, 'sweep');
  assert.match(out.disabled[0].reason, /not implemented/);
  // ...but the full normalized list keeps it for the management UI
  assert.deepEqual(out.all.map((w) => `${w.name}:${w.type}:${w.ok}`), ['slack-one:slack:true', 'sweep:schedule:true']);
});

test('load: reports the on-disk version and migrates a v1 file in memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wload-'));
  const f = path.join(dir, 'watchers.json');
  fs.writeFileSync(f, JSON.stringify({
    slack: { botToken: '$TOK' },
    watchers: [{ name: 'mentions', channels: ['C1'], trigger: { type: 'mention', users: ['U1'] } }],
  }));
  const cfg = wconfig.load(f, { TOK: 'xoxb-9' });
  assert.equal(cfg.present, true);
  assert.equal(cfg.fileVersion, 1);
  assert.equal(cfg.version, 2);
  assert.equal(cfg.watchers[0].trigger.type, 'slack');
  assert.equal(cfg.token, 'xoxb-9');
  // the file itself is NOT rewritten to upgrade it
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).version, undefined);

  const missing = wconfig.load(path.join(dir, 'nope.json'));
  assert.equal(missing.present, false);
  assert.deepEqual(missing.watchers, []);
  assert.deepEqual(missing.bots, {});
});

test('backupOnce: copies the config once, then leaves the copy alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbak-'));
  const f = path.join(dir, 'watchers.json');
  fs.writeFileSync(f, '{"first":true}');
  assert.equal(wconfig.backupOnce(f), true);
  assert.equal(fs.readFileSync(`${f}.bak`, 'utf8'), '{"first":true}');
  fs.writeFileSync(f, '{"second":true}');
  assert.equal(wconfig.backupOnce(f), true);
  assert.equal(fs.readFileSync(`${f}.bak`, 'utf8'), '{"first":true}', 'the original copy survives');
  assert.equal(wconfig.backupOnce(path.join(dir, 'nope.json')), false);
});

test('setEnabled: backs the file up once and preserves its schema version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wset2-'));
  const f = path.join(dir, 'watchers.json');
  const v1 = {
    '//note': 'kept',
    slack: { botToken: '$T' },
    watchers: [{ name: 'mentions', enabled: true, channels: ['C1'], trigger: { type: 'mention', users: ['U1'] } }],
  };
  fs.writeFileSync(f, JSON.stringify(v1));
  assert.equal(wconfig.setEnabled('mentions', false, f), true);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.watchers[0].enabled, false);
  assert.equal(raw.version, undefined, 'pause does not force a schema upgrade');
  assert.equal(raw['//note'], 'kept');
  assert.deepEqual(raw.watchers[0].trigger, { type: 'mention', users: ['U1'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8')), v1, 'pre-rewrite backup');
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

test('seen: mark + isSeen keyed by channel:thread:mention', () => {
  freshState();
  assert.equal(state.isSeen('w', 'C1', 't1', 'm1'), false);
  state.markSeen('w', 'C1', 't1', 'm1', 1000);
  assert.equal(state.isSeen('w', 'C1', 't1', 'm1'), true);
  assert.equal(state.isSeen('w', 'C1', 't2', 'm1'), false);
  // the point of the finer key: another mention in the SAME thread is not "seen"
  assert.equal(state.isSeen('w', 'C1', 't1', 'm2'), false, 'a new mention in a decided thread still counts');
  // and the thread-level key (used to collapse one pass) is separate
  assert.equal(state.isSeen('w', 'C1', 't1'), false);
});

test('prune: drops aged threads/seen and caps thread count', () => {
  freshState();
  const now = 10 * 86400000;
  state.trackThread('w', 'C1', 'old', now - 5 * 86400000); // 5d old
  state.trackThread('w', 'C1', 'new', now);
  state.markSeen('w', 'C1', 'oldseen', 'm', now - 8 * 86400000); // 8d old
  state.markSeen('w', 'C1', 'newseen', 'm', now);
  const r = state.prune('w', {
    nowMs: now,
    threadTtlMs: 3 * 86400000,
    seenTtlMs: 7 * 86400000,
    maxThreads: 50,
  });
  const c = state.forChannel('w', 'C1');
  assert.ok(!c.threads.old && c.threads.new, 'aged thread pruned, fresh kept');
  assert.ok(!state.forWatcher('w').seen['C1:oldseen:m'] && state.forWatcher('w').seen['C1:newseen:m'], 'aged seen pruned');
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
  state.markSeen('w', 'C1', 't1', 'm1', 1000);
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

test('buildPrompt: intent mode lists intents and asks for intent+prompt+confidence', () => {
  const p = classify.buildPrompt({
    threadText: 't', intents: [{ name: 'pr-review', description: 'review a PR' }],
    permalink: 'https://slack/x',
  });
  assert.match(p, /pr-review: review a PR/);
  assert.match(p, /"intent".*"prompt".*"confidence"/s);
  assert.match(p, /crisp hand-off/); // the model now authors the launch prompt too
  assert.match(p, /Slack thread link: https:\/\/slack\/x/); // permalink woven into context
  assert.doesNotMatch(p, /"skill"/); // but it still does not pick a skill in intent mode
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
  assert.equal(c.ref.slackPermalink, 'https://slack/x');
  assert.equal(c.ref.channelName, '#chan-C1');
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
  assert.equal(candidates.added[0].ref.channelName, '#chan-C1'); // channel name carried for the card
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
  assert.equal(state.isSeen('w', 'C1', '100.1', '100.1'), true); // that mention won't be reclassified
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
  assert.match(c.prompt, /Slack thread:/); // deterministic fallback: model returned no prompt
  assert.match(c.prompt, /acme\/widgets#9/);
  assert.match(c.reason, /matched intent "pr-review"/);
});

test('runWatcherOnce: intent mode uses the model-authored prompt when present', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const client = stubClient({
    history: [{ ts: '100.1', text: 'hey <@U1> review github.com/acme/widgets/pull/9' }],
    repliesByTs: { '100.1': [{ ts: '100.1', user: 'U2', text: 'hey <@U1> review github.com/acme/widgets/pull/9' }] },
  });
  const r = await loop.runWatcherOnce(INTENT_WATCHER, {
    client, candidates,
    // model names the intent AND drafts a crisp hand-off prompt
    classify: async () => ({
      intent: 'pr-review', confidence: 0.9,
      prompt: 'Review acme/widgets#9 using the skill. Amit asked whether the retry loop is correct. AK-42 tracks it.',
    }),
    resolveRepo: (rr) => (rr === 'acme/widgets' ? '/local/widgets' : null),
    retention: RETENTION, nowMs: 1000,
  });
  assert.equal(r.staged, 1);
  const c = candidates.added[0];
  assert.equal(c.skill, 'review-java'); // skill still from the config map, not the model
  assert.match(c.prompt, /Amit asked whether the retry loop is correct/); // model's prompt used
  assert.doesNotMatch(c.prompt, /Thread \(oldest first\)/); // not the raw thread dump
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
  assert.equal(state.isSeen('w', 'C1', '100.1', '100.1'), true);
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

// ---- config write path: create / update / delete, merge-don't-replace -------

function tmpCfg(contents) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsave-')), 'watchers.json');
  if (contents !== undefined) fs.writeFileSync(f, JSON.stringify(contents, null, 2));
  return f;
}

test('saveWatcher: creates a watcher in a file that does not exist yet', () => {
  const f = tmpCfg();
  const r = wconfig.saveWatcher(null, {
    name: 'new-one',
    trigger: { type: 'slack', mentions: ['U1'], channels: ['C1'] },
    rules: [{ name: 'pr', about: 'a PR', action: { type: 'skill', skill: 'review-go' } }],
  }, f);
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.name, 'new-one');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(raw.watchers.length, 1);
  assert.deepEqual(raw.watchers[0].trigger, {
    type: 'slack', mentions: ['U1'], channels: ['C1'], botRef: 'default',
  });
});

test('saveWatcher: merges onto the stored watcher — unknown keys and comments survive', () => {
  const f = tmpCfg({
    version: 2,
    '//top': 'kept',
    slack: { bots: { default: { token: '$T' } } },
    watchers: [{
      name: 'mentions',
      '//note': 'hand-written, keep me',
      customField: 42,
      enabled: true,
      trigger: { type: 'slack', botRef: 'default', mentions: ['U1'], channels: ['C1'] },
      rules: [{ name: 'pr', about: 'x', action: { type: 'skill', skill: 'review-go' } }],
      poll: { everySeconds: 300 },
      action: { preferCheckout: 'acme', cwd: '/repos' },
    }],
  });
  // patch ONLY the channels inside trigger, and only cwd inside action
  const r = wconfig.saveWatcher('mentions', {
    trigger: { channels: ['C1', 'C2'] },
    action: { cwd: '/repos/other' },
  }, f);
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  const w = JSON.parse(fs.readFileSync(f, 'utf8')).watchers[0];
  assert.deepEqual(w.trigger.channels, ['C1', 'C2']);
  assert.deepEqual(w.trigger.mentions, ['U1'], 'nested block merges, not replaces');
  assert.equal(w.trigger.botRef, 'default');
  assert.equal(w.action.preferCheckout, 'acme', 'sibling key in the same block survives');
  assert.equal(w.action.cwd, '/repos/other');
  assert.deepEqual(w.poll, { everySeconds: 300 }, 'untouched block unchanged');
  assert.equal(w['//note'], 'hand-written, keep me');
  assert.equal(w.customField, 42);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8'))['//top'], 'kept');
});

test('saveWatcher: an editor save upgrades a v1 file to v2 (and backs it up once)', () => {
  const v1 = {
    slack: { botToken: '$T' },
    watchers: [{
      name: 'mentions', enabled: true, channels: 'auto',
      trigger: { type: 'mention', users: ['U1'] },
      intents: [{ name: 'pr', description: 'a PR', skill: 'review-go' }],
    }],
  };
  const f = tmpCfg(v1);
  const r = wconfig.saveWatcher('mentions', { poll: { everySeconds: 60 } }, f);
  assert.equal(r.ok, true);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.slack, { bots: { default: { token: '$T' } } });
  assert.equal(raw.watchers[0].trigger.type, 'slack');
  assert.deepEqual(raw.watchers[0].trigger.mentions, ['U1']);
  assert.equal(raw.watchers[0].trigger.channels, 'auto');
  assert.equal(raw.watchers[0].intents, undefined);
  assert.equal(raw.watchers[0].rules[0].action.skill, 'review-go');
  assert.equal(raw.watchers[0].poll.everySeconds, 60);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8')), v1, 'pre-rewrite backup');
});

test('saveWatcher: refuses to write a watcher that could not run (fail-closed at the door)', () => {
  const f = tmpCfg({ version: 2, slack: { bots: { default: { token: '$T' } } }, watchers: [] });
  const before = fs.readFileSync(f, 'utf8');

  const noMentions = wconfig.saveWatcher(null, { name: 'a', trigger: { type: 'slack', channels: ['C1'] } }, f);
  assert.equal(noMentions.ok, false);
  assert.match(noMentions.error, /mention/);

  const noChannels = wconfig.saveWatcher(null, { name: 'b', trigger: { type: 'slack', mentions: ['U1'] } }, f);
  assert.equal(noChannels.ok, false);
  assert.match(noChannels.error, /channels/);

  const noPrompt = wconfig.saveWatcher(null, { name: 'c', trigger: { type: 'schedule', everyMinutes: 10 } }, f);
  assert.equal(noPrompt.ok, false);
  assert.match(noPrompt.error, /prompt/);

  assert.equal(fs.readFileSync(f, 'utf8'), before, 'nothing was written');
  assert.equal(fs.existsSync(`${f}.bak`), false, 'a rejected save does not even back up');
});

test('saveWatcher: validates a disabled watcher as if enabled, and still saves it disabled', () => {
  const f = tmpCfg({ version: 2, slack: { bots: { default: { token: '$T' } } }, watchers: [] });
  const r = wconfig.saveWatcher(null, {
    name: 'parked', enabled: false,
    trigger: { type: 'slack', mentions: ['U1'], channels: ['C1'] },
  }, f);
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).watchers[0].enabled, false);
});

test('saveWatcher: unknown target, duplicate name, and bad name are rejected', () => {
  const f = tmpCfg({
    version: 2,
    slack: { bots: { default: { token: '$T' } } },
    watchers: [
      { name: 'one', trigger: { type: 'slack', mentions: ['U1'], channels: ['C1'] } },
      { name: 'two', trigger: { type: 'slack', mentions: ['U1'], channels: ['C1'] } },
    ],
  });
  assert.match(wconfig.saveWatcher('ghost', { poll: { everySeconds: 60 } }, f).error, /unknown watcher/);
  assert.match(wconfig.saveWatcher('two', { name: 'one' }, f).error, /already exists/);
  assert.match(wconfig.saveWatcher('two', { name: 'bad/name' }, f).error, /invalid watcher name/);
  assert.equal(wconfig.saveWatcher('two', 'nope', f).ok, false);
});

test('saveWatcher: renames in place and pins the derived name', () => {
  const f = tmpCfg({
    version: 2,
    slack: { bots: { default: { token: '$T' } } },
    // no explicit name → derived 'watcher-1'
    watchers: [{ trigger: { type: 'slack', mentions: ['U1'], channels: ['C1'] } }],
  });
  const r = wconfig.saveWatcher('watcher-1', { name: 'mentions' }, f);
  assert.equal(r.ok, true);
  assert.equal(r.renamed, true);
  assert.equal(r.name, 'mentions');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).watchers[0].name, 'mentions');
});

test('deleteWatcher: drops one watcher, leaves the rest, errors on unknown', () => {
  const f = tmpCfg({
    version: 2,
    slack: { bots: { default: { token: '$T' } } },
    watchers: [
      { name: 'one', trigger: { type: 'slack', mentions: ['U1'], channels: ['C1'] } },
      { name: 'two', trigger: { type: 'slack', mentions: ['U1'], channels: ['C2'] } },
    ],
  });
  assert.equal(wconfig.deleteWatcher('one', f).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).watchers.map((w) => w.name), ['two']);
  assert.equal(wconfig.deleteWatcher('one', f).ok, false, 'already gone');
  assert.equal(wconfig.deleteWatcher('', f).ok, false);
  assert.equal(wconfig.deleteWatcher('two', path.join(path.dirname(f), 'nope.json')).ok, false);
});

test('mergeWatcherRaw: only known keys are patched, nested blocks merge', () => {
  const out = wconfig.mergeWatcherRaw(
    { name: 'w', extra: 1, trigger: { type: 'slack', mentions: ['U1'] }, poll: { everySeconds: 120 } },
    { trigger: { channels: ['C1'] }, rules: [], bogus: 'ignored', extra: 99 }
  );
  assert.deepEqual(out.trigger, { type: 'slack', mentions: ['U1'], channels: ['C1'] });
  assert.deepEqual(out.rules, []);
  assert.equal(out.bogus, undefined, 'unknown patch keys are not applied');
  assert.equal(out.extra, 1, 'stored extras are not overwritten by unknown patch keys');
  assert.deepEqual(out.poll, { everySeconds: 120 });
});

test('editableConfig: raw v2 watchers + bot references, never a resolved secret', () => {
  const f = tmpCfg({
    slack: { botToken: '$WCFG_TOK' },
    watchers: [
      { name: 'good', channels: ['C1'], trigger: { type: 'mention', users: ['U1'] } },
      { name: 'broken', channels: [], trigger: { type: 'mention', users: ['U1'] } },
    ],
  });
  const view = wconfig.editableConfig(f, { WCFG_TOK: 'xoxb-secret' });
  assert.equal(view.present, true);
  assert.equal(view.version, 2);
  assert.deepEqual(view.bots, [{ ref: 'default', label: '', tokenRef: '$WCFG_TOK', resolves: true }]);
  assert.equal(JSON.stringify(view).includes('xoxb-secret'), false, 'no secret in the payload');
  assert.deepEqual(view.watchers.map((w) => `${w.name}:${w.ok}`), ['good:true', 'broken:false']);
  assert.match(view.watchers[1].reason, /channels/);
  // raw is v2-shaped, i.e. exactly what a save patches
  assert.equal(view.watchers[0].raw.trigger.type, 'slack');
  assert.deepEqual(view.watchers[0].raw.trigger.mentions, ['U1']);

  const missing = wconfig.editableConfig(path.join(path.dirname(f), 'nope.json'));
  assert.equal(missing.present, false);
  assert.deepEqual(missing.watchers, []);
  assert.deepEqual(missing.bots, []);
});

// ---- runtime reconcile: an edit takes effect without a restart -------------

function armLoop() {
  const fakeClient = {
    history: async () => ({ messages: [], has_more: false }),
    replies: async () => ({ messages: [], has_more: false }),
    permalink: async () => ({ permalink: '' }),
  };
  loop._setTestHooks({
    buildDeps: () => ({ client: fakeClient, repoMap: { resolve: () => null, list: () => [] },
      skillList: [], retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 10 } }),
    scheduleInterval: () => ({}),
  });
}

test('upsertWatcher: create → running, update → applied live, delete → gone', async () => {
  const cfgFile = wconfig.FILE;
  process.env.WATCH_TEST_TOK = 'xoxb-test';
  fs.writeFileSync(cfgFile, JSON.stringify({
    version: 2, slack: { bots: { default: { token: '$WATCH_TEST_TOK' } } }, watchers: [],
  }));
  freshState();
  loop._reset();
  armLoop();
  loop.start();

  const stateOf = (n) => {
    const w = loop.getStatus().watchers.find((x) => x.name === n);
    return w ? w.state : null;
  };

  const created = loop.upsertWatcher(null, {
    name: 'live', trigger: { type: 'slack', mentions: ['U1'], channels: ['C1'] },
    poll: { everySeconds: 120 },
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.state, 'running');
  assert.equal(stateOf('live'), 'running');

  // update the poll interval → reflected in the live entry
  const updated = loop.upsertWatcher('live', { poll: { everySeconds: 600 } });
  assert.equal(updated.ok, true);
  assert.equal(updated.created, false);
  assert.equal(loop.getStatus().watchers.find((w) => w.name === 'live').everySeconds, 600);

  // an invalid patch changes neither the file nor the runtime
  const before = fs.readFileSync(cfgFile, 'utf8');
  const bad = loop.upsertWatcher('live', { trigger: { mentions: [] } });
  assert.equal(bad.ok, false);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), before);
  assert.equal(stateOf('live'), 'running');

  // saving it disabled parks it as paused (resumable), not gone
  assert.equal(loop.upsertWatcher('live', { enabled: false }).state, 'paused');
  assert.equal(stateOf('live'), 'paused');
  assert.equal(loop.upsertWatcher('live', { enabled: true }).state, 'running');

  // rename retires the old runtime entry
  const renamed = loop.upsertWatcher('live', { name: 'live2' });
  assert.equal(renamed.renamed, true);
  assert.equal(stateOf('live'), null);
  assert.equal(stateOf('live2'), 'running');

  // delete → out of the config and out of the runtime
  assert.equal(loop.removeWatcher('live2').ok, true);
  assert.equal(stateOf('live2'), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).watchers, []);
  assert.equal(loop.removeWatcher('live2').ok, false, 'already gone');

  loop.stop();
  fs.unlinkSync(cfgFile);
  delete process.env.WATCH_TEST_TOK;
});

test('listBots / listChannels: identity + channel picker data, failures are per-bot', async () => {
  const cfgFile = wconfig.FILE;
  process.env.WATCH_TEST_TOK = 'xoxb-test';
  fs.writeFileSync(cfgFile, JSON.stringify({
    version: 2,
    slack: {
      bots: {
        default: { token: '$WATCH_TEST_TOK', label: 'dash-bot' },
        broken: { token: '$NOT_SET_ANYWHERE' },
      },
    },
    watchers: [],
  }));
  loop._reset();
  loop._setTestHooks({
    createClient: (token) => ({
      authTest: async () => {
        if (token !== 'xoxb-test') throw new Error('slack auth.test: invalid_auth');
        return { user: 'dash-bot', team: 'acme', bot_id: 'B1' };
      },
      userConversations: async ({ types, cursor }) => {
        if (types.includes('private_channel')) throw new Error('slack users.conversations: missing_scope');
        if (cursor) return { channels: [{ id: 'C2', name: 'second' }] };
        return {
          channels: [{ id: 'C1', name: 'first', is_private: false, is_archived: true }],
          response_metadata: { next_cursor: 'page2' },
        };
      },
    }),
  });

  const { bots } = await loop.listBots();
  assert.deepEqual(bots.map((b) => b.ref), ['default', 'broken']);
  assert.deepEqual(bots[0].identity, { user: 'dash-bot', team: 'acme', botId: 'B1' });
  assert.equal(bots[0].label, 'dash-bot');
  assert.equal(bots[0].error, null);
  assert.equal(bots[1].identity, null);
  assert.match(bots[1].error, /could not be read/, 'an unresolvable reference is reported, not thrown');
  assert.equal(JSON.stringify(bots).includes('xoxb-test'), false, 'no token in the payload');

  // degrades to public-only on missing_scope, and follows pagination
  const chans = await loop.listChannels('default');
  assert.equal(chans.ok, true);
  assert.equal(chans.private, false);
  assert.deepEqual(chans.channels.map((c) => c.id), ['C1', 'C2']);
  assert.equal(chans.channels[0].archived, true);

  assert.equal((await loop.listChannels('ghost')).ok, false);
  assert.match((await loop.listChannels('broken')).error, /could not be read/);

  loop.stop();
  fs.unlinkSync(cfgFile);
  delete process.env.WATCH_TEST_TOK;
});

test('normalizeWatcher: a schedule watcher may name a skill to run its prompt under', () => {
  const n = wconfig.normalizeWatcher(
    { name: 's', trigger: { type: 'schedule', everyMinutes: 30 }, prompt: 'go find work', skill: 'review-go' },
    0
  );
  assert.equal(n.ok, true);
  assert.equal(n.skill, 'review-go');
  // optional…
  assert.equal(wconfig.normalizeWatcher({ name: 's', trigger: { type: 'schedule', at: '09:00' }, prompt: 'go' }, 0).skill, '');
  // …but not a bogus one
  const bad = wconfig.normalizeWatcher(
    { name: 's', trigger: { type: 'schedule', everyMinutes: 30 }, prompt: 'go', skill: 'has space' },
    0
  );
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /invalid skill name/);
});

test('saveWatcher: `skill` is an editor-owned key on a schedule watcher', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wskill-')), 'watchers.json');
  fs.writeFileSync(f, JSON.stringify({ version: 2, slack: { bots: {} }, watchers: [] }));
  assert.equal(wconfig.saveWatcher(null, {
    name: 'sweep', trigger: { type: 'schedule', everyMinutes: 60 }, prompt: 'find work', skill: 'review-go',
  }, f).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).watchers[0].skill, 'review-go');
  // a later patch can clear it
  assert.equal(wconfig.saveWatcher('sweep', { skill: '' }, f).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).watchers[0].skill, '');
});

// ---- repos: the folder pickers' data ---------------------------------------

test('repos dirs: lists every checkout, including both copies of a twice-cloned repo', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wrepos-'));
  const mk = (parent, name, url) => {
    const dir = path.join(base, parent, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
    return dir;
  };
  mk('primary', 'svc', 'git@github.com:acme/svc.git');
  mk('scratch', 'svc', 'git@github.com:acme/svc.git'); // same repo, second clone
  mk('primary', 'lib', 'git@github.com:acme/lib.git');

  const rm = repos.create({ base, depth: 2, preferDir: 'scratch' });
  assert.deepEqual(rm.dirs(), [
    path.join(base, 'primary', 'lib'),
    path.join(base, 'primary', 'svc'),
    path.join(base, 'scratch', 'svc'), // the second clone survives; the map drops it
  ]);
  // preferDir still decides which clone resolves
  assert.equal(rm.resolve('acme/svc'), path.join(base, 'scratch', 'svc'));
});

// ---- pace.js: the one queue every Slack call goes through -------------------

const pace = require('../server/src/services/watchers/pace');

/** A fake clock: `sleep` advances it instead of waiting, so tests are instant. */
function fakeClock() {
  let t = 1000;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
    at: () => t,
  };
}

test('pacer: serializes tasks and spaces their starts by the minimum gap', async () => {
  const clock = fakeClock();
  const p = pace.createPacer({ minGapMs: 1000, now: clock.now, sleep: clock.sleep });
  const starts = [];
  const task = (id) => () => { starts.push([id, clock.at()]); return Promise.resolve(id); };

  const all = await Promise.all([p.run(task('a')), p.run(task('b')), p.run(task('c'))]);
  assert.deepEqual(all, ['a', 'b', 'c'], 'results come back in submission order');
  assert.deepEqual(starts.map((s) => s[0]), ['a', 'b', 'c'], 'one at a time, in order');
  const [t0, t1, t2] = starts.map((s) => s[1]);
  assert.ok(t1 - t0 >= 1000, `second call waited the gap (${t1 - t0}ms)`);
  assert.ok(t2 - t1 >= 1000, `third call waited the gap (${t2 - t1}ms)`);
});

test('pacer: an interactive call jumps queued background work', async () => {
  const clock = fakeClock();
  const p = pace.createPacer({ minGapMs: 1000, now: clock.now, sleep: clock.sleep });
  const starts = [];
  const task = (id) => () => { starts.push(id); return Promise.resolve(id); };

  // 'a' takes the in-flight slot immediately; b/c queue behind it. The
  // interactive call is submitted LAST but must run before them.
  const pending = [p.run(task('a')), p.run(task('b')), p.run(task('c'))];
  pending.push(p.run(task('ui'), { interactive: true }));
  await Promise.all(pending);

  assert.deepEqual(starts, ['a', 'ui', 'b', 'c'], 'ui overtook queued work but not the in-flight call');
});

test('pacer: interactive calls still pay the gap — priority changes order, not rate', async () => {
  const clock = fakeClock();
  const p = pace.createPacer({ minGapMs: 1000, now: clock.now, sleep: clock.sleep });
  const starts = [];
  const task = () => () => { starts.push(clock.at()); return Promise.resolve(); };
  await Promise.all([
    p.run(task(), { interactive: true }),
    p.run(task(), { interactive: true }),
    p.run(task(), { interactive: true }),
  ]);
  assert.ok(starts[1] - starts[0] >= 1000, `gap held (${starts[1] - starts[0]}ms)`);
  assert.ok(starts[2] - starts[1] >= 1000, `gap held (${starts[2] - starts[1]}ms)`);
});

test('pacer: a failing task rejects its own caller without stalling the queue', async () => {
  const clock = fakeClock();
  const p = pace.createPacer({ minGapMs: 1, now: clock.now, sleep: clock.sleep });
  const boom = p.run(() => Promise.reject(new Error('nope')));
  const after = p.run(() => Promise.resolve('ran'));
  await assert.rejects(boom, /nope/);
  assert.equal(await after, 'ran', 'the queue kept draining past the failure');
  assert.equal(p.stats().queued, 0, 'nothing left queued');
});

test('pacer: a rate-limited call pauses the queue, widens the gap, and retries', async () => {
  const clock = fakeClock();
  const logs = [];
  const p = pace.createPacer({
    minGapMs: 100, now: clock.now, sleep: clock.sleep, log: (l) => logs.push(l),
  });
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) {
      const e = new Error('ratelimited');
      e.rateLimited = true;
      e.retryAfterMs = 5000;
      throw e;
    }
    return 'ok';
  };
  const started = clock.at();
  assert.equal(await p.run(flaky), 'ok');
  assert.equal(attempts, 2, 'retried once');
  assert.ok(clock.at() - started >= 5000, "waited Slack's Retry-After");
  assert.equal(p.stats().gapMs, 200, 'gap doubled under pressure');
  assert.ok(logs.some((l) => l.includes('rate-limited')), 'backoff is logged');
});

test('pacer: gives up after maxAttempts and rethrows the rate-limit error', async () => {
  const clock = fakeClock();
  const p = pace.createPacer({ minGapMs: 10, maxAttempts: 3, now: clock.now, sleep: clock.sleep });
  let attempts = 0;
  await assert.rejects(
    () => p.run(async () => {
      attempts += 1;
      const e = new Error('ratelimited');
      e.rateLimited = true;
      throw e;
    }),
    /ratelimited/
  );
  assert.equal(attempts, 3);
});

test('pacer: the gap never exceeds maxGapMs', async () => {
  const clock = fakeClock();
  const p = pace.createPacer({ minGapMs: 1000, maxGapMs: 2000, maxAttempts: 9, now: clock.now, sleep: clock.sleep });
  let attempts = 0;
  await p.run(async () => {
    attempts += 1;
    if (attempts < 5) {
      const e = new Error('ratelimited');
      e.rateLimited = true;
      throw e;
    }
    return 'ok';
  });
  assert.equal(p.stats().gapMs, 2000, 'capped');
});

test('pacer: eases the gap back after a clean streak', async () => {
  const clock = fakeClock();
  const p = pace.createPacer({
    minGapMs: 100, decayAfter: 2, now: clock.now, sleep: clock.sleep,
  });
  let first = true;
  await p.run(async () => {
    if (first) { first = false; const e = new Error('rl'); e.rateLimited = true; throw e; }
    return 'ok';
  });
  assert.equal(p.stats().gapMs, 200, 'widened by the 429');
  await p.run(async () => 'ok');
  await p.run(async () => 'ok'); // hits decayAfter
  assert.equal(p.stats().gapMs, 100, 'back to the floor after calm');
});

test('pacer: a non-rate-limit error propagates without touching the gap or the queue', async () => {
  const clock = fakeClock();
  const p = pace.createPacer({ minGapMs: 50, now: clock.now, sleep: clock.sleep });
  await assert.rejects(() => p.run(async () => { throw new Error('not_in_channel'); }), /not_in_channel/);
  assert.equal(p.stats().gapMs, 50, 'gap unchanged — this is not backpressure');
  assert.equal(await p.run(async () => 'still works'), 'still works', 'queue survives a failure');
});

test('slack client: a 429 is retried through the pacer, not per call', async () => {
  const clock = fakeClock();
  const pacer = pace.createPacer({ minGapMs: 10, now: clock.now, sleep: clock.sleep });
  let calls = 0;
  const client = slack.createClient({
    token: 'xoxb-test',
    pacer,
    request: async () => {
      calls += 1;
      if (calls === 1) return { status: 429, headers: { 'retry-after': '2' }, body: '{"ok":false,"error":"ratelimited"}' };
      return { status: 200, headers: {}, body: '{"ok":true,"channels":[]}' };
    },
  });
  const out = await client.userConversations({ types: 'public_channel' });
  assert.deepEqual(out.channels, []);
  assert.equal(calls, 2, 'the pacer retried the call');
  assert.ok(pacer.stats().gapMs > 10, 'and widened the gap');
});

test('slack client: an ok:false body that is not rate limiting throws straight through', async () => {
  const clock = fakeClock();
  const pacer = pace.createPacer({ minGapMs: 1, now: clock.now, sleep: clock.sleep });
  const client = slack.createClient({
    token: 'xoxb-test',
    pacer,
    request: async () => ({ status: 200, headers: {}, body: '{"ok":false,"error":"missing_scope"}' }),
  });
  await assert.rejects(() => client.info({ channel: 'C1' }), /missing_scope/);
});

test('runWatcherOnce: a NEW mention in an already-decided thread stages again', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  // pass 1: the thread is decided (classifier declines) and marked seen
  const first = stubClient({ history: [{ ts: '100.1', text: 'hey <@U1> thoughts?' }] });
  await loop.runWatcherOnce(WATCHER, {
    client: first, candidates, classify: async () => ({ actionable: false }),
    resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.equal(candidates.added.length, 0);
  assert.equal(state.isSeen('w', 'C1', '100.1', '100.1'), true);

  // pass 2: a follow-up ping arrives as a reply in that same thread. Keyed per
  // thread this was silently dropped for the whole seen TTL; keyed per mention it
  // is a fresh ask and stages.
  const second = stubClient({
    history: [],
    repliesByTs: {
      '100.1': [
        { ts: '100.1', user: 'U2', text: 'hey <@U1> thoughts?' },
        { ts: '200.5', user: 'U2', text: 'bumping this <@U1> — please take a look' },
      ],
    },
  });
  const r2 = await loop.runWatcherOnce(WATCHER, {
    client: second, candidates, classify: async () => ({ actionable: true, skill: 'debug', reason: 'asked again' }),
    resolveRepo: () => '/x', retention: RETENTION, nowMs: 2000,
  });
  assert.equal(r2.staged, 1, 'the follow-up ping produced a candidate');
  assert.equal(state.isSeen('w', 'C1', '100.1', '200.5'), true, 'the new mention is now decided too');
  assert.equal(state.isSeen('w', 'C1', '100.1', '100.1'), true, 'and the original stays decided');
});

test('runWatcherOnce: the same mention is never staged twice', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  const msg = { ts: '100.1', text: 'hey <@U1> please review' };
  const deps = () => ({
    client: stubClient({ history: [msg], repliesByTs: { '100.1': [{ ...msg, user: 'U2' }] } }),
    candidates,
    classify: async () => ({ actionable: true, skill: 'debug', reason: 'r' }),
    resolveRepo: () => '/x',
    retention: RETENTION,
    nowMs: 1000,
  });
  assert.equal((await loop.runWatcherOnce(WATCHER, deps())).staged, 1);
  assert.equal((await loop.runWatcherOnce(WATCHER, deps())).staged, 0, 'second pass re-reads it but does not re-stage');
  assert.equal(candidates.added.length, 1);
});

test('runWatcherOnce: an excluded channel is never scanned', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  let historyCalls = 0;
  const client = {
    async history() { historyCalls++; return { messages: [{ ts: '100.1', text: 'hey <@U1>' }], has_more: false }; },
    async replies() { return { messages: [], has_more: false }; },
    async permalink() { return { permalink: 'https://slack/x' }; },
    async info({ channel }) { return { channel: { id: channel, name: `chan-${channel}` } }; },
  };
  const w = { ...WATCHER, channels: ['C1', 'C2'], excludeChannels: ['C2'] };
  const r = await loop.runWatcherOnce(w, {
    client, candidates, classify: alwaysActionable,
    resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.equal(historyCalls, 1, 'only the non-excluded channel was fetched');
  assert.equal(r.staged, 1);
});

test('runWatcherOnce: excluding a channel reclaims its tracked threads', async () => {
  freshArmed();
  // C2 has history from before it was excluded — the cost we want back
  state.advanceCursor('w', 'C2', '1');
  state.trackThread('w', 'C2', 't1', 1000);
  state.trackThread('w', 'C2', 't2', 1000);
  state.markSeen('w', 'C2', 't1', 'm1', 1000);
  assert.equal(Object.keys(state.forChannel('w', 'C2').threads).length, 2);

  const w = { ...WATCHER, channels: ['C1', 'C2'], excludeChannels: ['C2'] };
  await loop.runWatcherOnce(w, {
    client: stubClient({ history: [] }), candidates: fakeCandidates(),
    classify: alwaysActionable, resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.equal(Object.keys(state.forChannel('w', 'C2').threads).length, 0, 'threads dropped');
  assert.equal(state.isSeen('w', 'C2', 't1', 'm1'), false, 'seen-markers dropped too');
  // cursor is deliberately kept, so un-excluding backfills instead of skipping
  assert.equal(state.cursorOf('w', 'C2'), '1');
});

test('runWatcherOnce: all channels excluded stages nothing and calls Slack not at all', async () => {
  freshArmed();
  let calls = 0;
  const client = {
    async history() { calls++; return { messages: [], has_more: false }; },
    async replies() { calls++; return { messages: [], has_more: false }; },
    async permalink() { return { permalink: 'x' }; },
    async info({ channel }) { return { channel: { id: channel, name: channel } }; },
  };
  const w = { ...WATCHER, channels: ['C1'], excludeChannels: ['C1'] };
  const r = await loop.runWatcherOnce(w, {
    client, candidates: fakeCandidates(), classify: alwaysActionable,
    resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.equal(calls, 0);
  assert.deepEqual(r, { staged: 0, scannedThreads: 0, newMessages: 0 });
});

test('runWatcherOnce: exclusion and pause are independent skips', async () => {
  freshArmed();
  const seen = [];
  const client = {
    async history({ channel }) { seen.push(channel); return { messages: [], has_more: false }; },
    async replies() { return { messages: [], has_more: false }; },
    async permalink() { return { permalink: 'x' }; },
    async info({ channel }) { return { channel: { id: channel, name: channel } }; },
  };
  state.setPaused('w', 'C2', true);
  const w = { ...WATCHER, channels: ['C1', 'C2', 'C3'], excludeChannels: ['C3'] };
  await loop.runWatcherOnce(w, {
    client, candidates: fakeCandidates(), classify: alwaysActionable,
    resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.deepEqual(seen, ['C1'], 'C2 paused, C3 excluded, only C1 scanned');
});

test('runWatcherOnce: two mentions of one thread in a single pass stage once', async () => {
  freshArmed();
  const candidates = fakeCandidates();
  // both the parent and a reply mention you in the same pass — one ask, one card
  const client = stubClient({
    history: [{ ts: '100.1', text: 'hey <@U1>' }],
    repliesByTs: { '100.1': [{ ts: '100.9', user: 'U2', text: 'still there <@U1>?' }] },
  });
  const r = await loop.runWatcherOnce(WATCHER, {
    client, candidates, classify: async () => ({ actionable: true, skill: 'debug', reason: 'r' }),
    resolveRepo: () => '/x', retention: RETENTION, nowMs: 1000,
  });
  assert.equal(r.staged, 1);
  assert.equal(candidates.added.length, 1, 'collapsed per thread within the pass');
});

test('classify: a failed headless run logs before degrading to unclassified', async () => {
  const lines = [];
  const plan = await classify.classify(
    { threadText: 'please review', prRefs: [{ repo: 'acme/widgets', number: 7 }] },
    {
      _run: async () => {
        throw new Error('spawn claude ENOENT');
      },
      _log: (l) => lines.push(l),
    }
  );
  assert.equal(plan.unclassified, true);
  assert.equal(plan.skill, '');
  assert.equal(lines.length, 1, 'the outage must leave exactly one trace');
  assert.match(lines[0], /classify unavailable/);
  assert.match(lines[0], /ENOENT/);
});

// ---- runGithubWatcherOnce -------------------------------------------------

/** A stub gh client returning a fixed queue; no subprocess, no network. */
function ghStub(prs, { login = 'me' } = {}) {
  const calls = [];
  return {
    calls,
    async login() {
      calls.push('login');
      return login;
    },
    async reviewQueue(args) {
      calls.push({ reviewQueue: args });
      return { total: prs.length, prs };
    },
  };
}

function ghPr(over = {}) {
  return {
    repo: 'acme/java-svc',
    number: 1,
    title: 'AK-1: a change',
    body: '',
    url: 'https://github.com/acme/java-svc/pull/1',
    author: 'human',
    isDraft: false,
    tipOid: 'aaaaaaa1111',
    tipCommittedDate: '2026-08-09T10:00:00Z',
    myLastReviewAt: null,
    ...over,
  };
}

/**
 * `seen` markers persist in the temp state file across `state._reset()` (which
 * only drops the cache), so each test gets its own watcher name — otherwise one
 * test's staged keys suppress the next test's identical PR.
 */
let ghWatcherSeq = 0;
function ghW(over = {}) {
  return { ...GH_WATCHER, name: `reviews-${++ghWatcherSeq}`, ...over };
}

const GH_WATCHER = {
  name: 'reviews',
  type: 'github',
  search: 'review-requested:@me is:open is:pr',
  login: '',
  projects: ['AK'],
  excludeAuthors: [],
  includeAuthors: [],
  skipDrafts: true,
  first: 50,
  maxGroupSize: 5,
  maxStagePerTick: 5,
  skillsByStack: { java: 'review-java', go: 'review-go' },
  defaultCwd: '/fallback',
  template: '',
};

test('runGithubWatcherOnce: stages one candidate per story, with repo and skill', async () => {
  state._reset();
  const added = [];
  const r = await loop.runGithubWatcherOnce(ghW(), {
    ghClient: ghStub([
      ghPr({ number: 1, title: 'AK-10 step one', body: 'AK-99' }),
      ghPr({ number: 2, title: 'AK-11 step two', body: 'AK-99' }),
      ghPr({ repo: 'acme/go-svc', number: 7, title: 'AK-20 solo' }),
    ]),
    resolveRepo: (repo) => `/code/${repo.split('/')[1]}`,
    detectStack: (dir) => (dir && dir.includes('go-svc') ? 'go' : 'java'),
    candidates: { add: (c) => added.push(c) },
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });

  assert.equal(r.staged, 2, 'a 2-PR story and a lone PR');
  assert.equal(r.total, 3);
  const story = added.find((c) => c.ref.storyKey === 'AK-99');
  assert.equal(story.cwd, '/code/java-svc');
  assert.equal(story.skill, 'review-java');
  assert.equal(story.source, 'github');
  assert.equal(story.producer, 'watcher');
  assert.equal(story.ref.prRefs.length, 2);
  const solo = added.find((c) => c.ref.storyKey === null);
  assert.equal(solo.skill, 'review-go');
});

test('runGithubWatcherOnce: needs no classifier at all', async () => {
  state._reset();
  // the classifier being unavailable must not affect this producer
  const r = await loop.runGithubWatcherOnce(ghW(), {
    ghClient: ghStub([ghPr()]),
    resolveRepo: () => '/code/java-svc',
    detectStack: () => 'java',
    candidates: { add: () => {} },
    classify: () => {
      throw new Error('classifier must not be called');
    },
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  assert.equal(r.staged, 1);
});

test('runGithubWatcherOnce: an unchanged PR is suppressed on the next pass', async () => {
  state._reset();
  const deps = () => ({
    ghClient: ghStub([ghPr()]),
    resolveRepo: () => '/code/java-svc',
    detectStack: () => 'java',
    candidates: { add: () => {} },
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  const w = ghW();
  const first = await loop.runGithubWatcherOnce(w, deps());
  assert.equal(first.staged, 1);
  const second = await loop.runGithubWatcherOnce(w, deps());
  assert.equal(second.staged, 0, 'same tip commit -> already decided');
  assert.equal(second.suppressed, 1);
});

test('runGithubWatcherOnce: a new commit resurfaces it as a re-review', async () => {
  state._reset();
  const base = {
    resolveRepo: () => '/code/java-svc',
    detectStack: () => 'java',
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };
  const w = ghW();
  const first = await loop.runGithubWatcherOnce(w, {
    ...base,
    ghClient: ghStub([ghPr({ tipOid: 'old1111' })]),
    candidates: { add: () => {} },
  });
  assert.equal(first.staged, 1);

  const added = [];
  const second = await loop.runGithubWatcherOnce(w, {
    ...base,
    // reviewed, then the author pushed: tip is newer than my review
    ghClient: ghStub([
      ghPr({ tipOid: 'new2222', myLastReviewAt: '2026-08-09T09:00:00Z', tipCommittedDate: '2026-08-09T12:00:00Z' }),
    ]),
    candidates: { add: (c) => added.push(c) },
  });
  assert.equal(second.staged, 1, 'a changed PR is not the decided one');
  assert.equal(added[0].priority, 2, 're-reviews outrank fresh ones');
});

test('runGithubWatcherOnce: resolves the login when config leaves it blank', async () => {
  state._reset();
  const client = ghStub([], { login: 'discovered-user' });
  await loop.runGithubWatcherOnce(ghW(), {
    ghClient: client,
    candidates: { add: () => {} },
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  assert.ok(client.calls.includes('login'));
  assert.equal(client.calls.find((c) => c.reviewQueue).reviewQueue.login, 'discovered-user');
});

test('runGithubWatcherOnce: a configured login skips the lookup call', async () => {
  state._reset();
  const client = ghStub([]);
  await loop.runGithubWatcherOnce(ghW({ login: 'fixed' }), {
    ghClient: client,
    candidates: { add: () => {} },
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  assert.ok(!client.calls.includes('login'));
  assert.equal(client.calls[0].reviewQueue.login, 'fixed');
});

test('runGithubWatcherOnce: a rejected candidate does not abort the pass', async () => {
  state._reset();
  const added = [];
  let n = 0;
  const r = await loop.runGithubWatcherOnce(ghW(), {
    ghClient: ghStub([
      ghPr({ number: 1, title: 'AK-1 one' }),
      ghPr({ number: 2, title: 'AK-2 two' }),
    ]),
    resolveRepo: () => '/code/java-svc',
    detectStack: () => 'java',
    candidates: {
      add: (c) => {
        if (++n === 1) throw new Error('candidate list is full');
        added.push(c);
      },
    },
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  assert.equal(r.staged, 1, 'the second one still lands');
  assert.equal(added.length, 1);
});

test('runGithubWatcherOnce: falls back to defaultCwd for a repo with no checkout', async () => {
  state._reset();
  const added = [];
  await loop.runGithubWatcherOnce(ghW(), {
    ghClient: ghStub([ghPr({ repo: 'acme/not-cloned' })]),
    resolveRepo: () => null,
    detectStack: () => null,
    candidates: { add: (c) => added.push(c) },
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  assert.equal(added[0].cwd, '/fallback');
  assert.equal(added[0].skill, '', 'no stack detected -> no skill guessed');
});

// ---- offline vs error: transient network faults ---------------------------

test('isTransientError: network weather yes, auth/config no', () => {
  // the fault classes actually measured on a sleeping laptop (779-tick run)
  for (const m of [
    'getaddrinfo ENOTFOUND slack.com',
    'read ECONNRESET',
    'write EPIPE',
    'read EADDRNOTAVAIL',
    'socket hang up',
    'slack conversations.replies: non-JSON response (HTTP 500)',
    'connect ETIMEDOUT 1.2.3.4:443',
  ]) {
    assert.equal(loop.isTransientError(m), true, m);
  }
  for (const m of ['invalid_auth', 'missing_scope', 'account_inactive', 'gh CLI not found (gh)']) {
    assert.equal(loop.isTransientError(m), false, m);
  }
});

test('a transient tick failure reads offline (self-healing), a repeated one escalates, auth is error at once', async () => {
  const cfgFile = wconfig.FILE;
  process.env.WATCH_TEST_TOK = 'xoxb-test';
  fs.writeFileSync(cfgFile, JSON.stringify({
    slack: { botToken: '$WATCH_TEST_TOK' },
    watchers: [{ name: 'mentions', enabled: true, channels: ['C1'],
      trigger: { type: 'mention', users: ['U1'] }, intents: [], poll: { everySeconds: 120 } }],
  }));
  freshState();
  loop._reset();

  let fail = null; // null = succeed, else the message to throw
  const flakyClient = {
    history: async () => {
      if (fail) throw new Error(fail);
      return { messages: [], has_more: false };
    },
    replies: async () => ({ messages: [], has_more: false }),
    permalink: async () => ({ permalink: '' }),
    info: async () => ({ channel: { name: 'chan' } }),
  };
  loop._setTestHooks({
    buildDeps: () => ({ client: flakyClient, repoMap: { resolve: () => null, list: () => [] },
      skillList: [], retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 10 } }),
    scheduleInterval: () => ({}),
  });
  loop.start();
  const me = () => loop.getStatus().watchers.find((w) => w.name === 'mentions');
  // start() fires an immediate un-awaited catch-up tick; drain it so runNow is
  // never skipped by the single-flight guard (that skip is correct behaviour,
  // but it would silently shift every assertion below by one pass)
  await new Promise((r) => setTimeout(r, 20));
  await loop.runNow('mentions'); // baseline pass so the cursor exists

  // one DNS blip -> offline, not error; the message and its class are reported
  fail = 'getaddrinfo ENOTFOUND slack.com';
  await loop.runNow('mentions');
  assert.equal(me().state, 'offline');
  assert.equal(me().lastErrorTransient, true);
  assert.match(me().lastError, /ENOTFOUND/);

  // recovery clears the current fault but keeps the history
  fail = null;
  await loop.runNow('mentions');
  assert.equal(me().state, 'running');
  assert.equal(me().lastError, null);
  assert.ok(me().lastErrorAt, 'the flap stays explainable after it healed');
  assert.equal(me().lastErrorTransient, true);

  // sustained network failure stops being weather
  fail = 'read ECONNRESET';
  for (let i = 0; i < 5; i++) await loop.runNow('mentions');
  assert.equal(me().state, 'error', 'escalates after consecutive transient failures');

  // an auth failure is never soft-pedaled
  fail = null;
  await loop.runNow('mentions'); // reset the streak
  fail = 'invalid_auth';
  await loop.runNow('mentions');
  assert.equal(me().state, 'error');
  assert.equal(me().lastErrorTransient, false);

  loop.stop();
});

test('saveWatcher round-trips a github watcher, including an author-mode switch', () => {
  const cfgFile = wconfig.FILE;
  fs.writeFileSync(cfgFile, JSON.stringify({ version: 2, watchers: [] }));

  // create — what the editor's Save sends for a new reviews watcher
  const created = wconfig.saveWatcher(null, {
    name: 'reviews',
    trigger: {
      type: 'github',
      search: 'review-requested:@me is:open is:pr',
      jiraProjects: ['ak'],
      includeAuthors: [],
      excludeAuthors: ['acme-buildbot'],
      skipDrafts: true,
      maxGroupSize: 5,
      maxStagePerTick: 5,
    },
    rules: [
      { name: 'java', about: 'a Java service', action: { type: 'skill', skill: 'review-java' } },
      { name: 'go', about: 'a Go service', action: { type: 'skill', skill: 'review-go' } },
    ],
    poll: { everySeconds: 900 },
    action: { cwd: '/tmp' },
  });
  assert.equal(created.ok, true, created.error);

  let norm = wconfig.load(cfgFile, {});
  assert.equal(norm.githubWatchers.length, 1);
  assert.deepEqual(norm.githubWatchers[0].projects, ['AK'], 'projects uppercased');
  assert.deepEqual(norm.githubWatchers[0].skillsByStack, { java: 'review-java', go: 'review-go' });

  // edit — flip to an includeAuthors (bot-batch) watcher; the patch sends BOTH
  // keys (inactive one empty) because the trigger merge is shallow
  const flipped = wconfig.saveWatcher('reviews', {
    name: 'reviews',
    trigger: {
      type: 'github',
      search: 'review-requested:@me is:open is:pr',
      jiraProjects: ['ak'],
      includeAuthors: ['dependabot'],
      excludeAuthors: [],
      skipDrafts: true,
      maxGroupSize: 5,
      maxStagePerTick: 5,
    },
    rules: [],
    poll: { everySeconds: 900 },
    action: { cwd: '/tmp' },
  });
  assert.equal(flipped.ok, true, flipped.error);
  norm = wconfig.load(cfgFile, {});
  assert.deepEqual(norm.githubWatchers[0].includeAuthors, ['dependabot']);
  assert.deepEqual(norm.githubWatchers[0].excludeAuthors, [], 'stale exclude list must not survive the switch');

  // both lists set is refused at the door, fail-closed
  const both = wconfig.saveWatcher('reviews', {
    trigger: { type: 'github', includeAuthors: ['a'], excludeAuthors: ['b'] },
  });
  assert.equal(both.ok, false);
  assert.match(both.error, /cannot set both/);
});

test('digest watcher: a changed queue supersedes its own previous pending digest', async () => {
  state._reset();
  const w = ghW({ group: 'all', includeAuthors: ['dependabot'] });
  const store = (() => {
    let seq = 0;
    const items = [];
    return {
      items,
      add(c) { const it = { ...c, id: `c${++seq}`, status: 'pending' }; items.push(it); return it; },
      list: () => items,
      remove(id) { const i = items.findIndex((x) => x.id === id); if (i !== -1) items.splice(i, 1); },
    };
  })();
  const base = {
    resolveRepo: () => '/c/x',
    detectStack: () => 'java',
    candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };
  const bump = (n, oid) => ghPr({ number: n, author: 'dependabot', title: `Bump thing ${n}`, tipOid: oid });

  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([bump(1, 'a1'), bump(2, 'b2')]) });
  assert.equal(store.items.length, 1);
  const firstId = store.items[0].id;
  assert.equal(store.items[0].ref.digest, true);

  // a third bump arrives -> new digest replaces the stale pending one
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([bump(1, 'a1'), bump(2, 'b2'), bump(3, 'c3')]) });
  assert.equal(store.items.length, 1, 'no overlapping batch cards');
  assert.notEqual(store.items[0].id, firstId);
  assert.equal(store.items[0].ref.prRefs.length, 3);

  // unchanged queue -> nothing staged, the digest is not endlessly rewritten
  const r3 = await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([bump(1, 'a1'), bump(2, 'b2'), bump(3, 'c3')]) });
  assert.equal(r3.staged, 0);
  assert.equal(store.items.length, 1);

  // a LAUNCHED digest is history — a new queue must not delete it
  store.items[0].status = 'launched';
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([bump(1, 'a1'), bump(4, 'd4')]) });
  assert.equal(store.items.length, 2, 'launched digest kept alongside the new pending one');
});

// ---- supersede: a fresh snapshot replaces stale pending cards --------------

function memStore() {
  let seq = 0;
  const items = [];
  return {
    items,
    add(c) { const it = { ...c, id: `c${++seq}`, status: 'pending' }; items.push(it); return it; },
    list: () => items,
    remove(id) { const i = items.findIndex((x) => x.id === id); if (i !== -1) items.splice(i, 1); },
  };
}

test('supersede: a push replaces the stale pending card for the same PR (the tps#5556 case)', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([ghPr({ number: 5556, title: 'AK-1 x', tipOid: 'aaa1' })]) });
  assert.equal(store.items.length, 1);

  // author pushes twice more — each pass must leave exactly ONE pending card
  for (const tip of ['bbb2', 'ccc3']) {
    await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([ghPr({ number: 5556, title: 'AK-1 x', tipOid: tip })]) });
    assert.equal(store.items.length, 1, `tip ${tip}: no stale duplicates`);
  }
  assert.match(store.items[0].dedupeKey, /@ccc3/);
});

test('supersede: a solo card is replaced when its PR joins a story group', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([ghPr({ number: 1, title: 'AK-10 a', body: 'AK-99' })]) });
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].ref.prRefs.length, 1);

  // a second PR citing the same epic arrives -> the pair stages as one story,
  // and the old solo card for PR 1 goes with it
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([
    ghPr({ number: 1, title: 'AK-10 a', body: 'AK-99' }),
    ghPr({ number: 2, title: 'AK-11 b', body: 'AK-99', tipOid: 'ddd4' }),
  ]) });
  assert.equal(store.items.length, 1, 'solo card superseded by the story card');
  assert.equal(store.items[0].ref.storyKey, 'AK-99');
  assert.equal(store.items[0].ref.prRefs.length, 2);
});

test('supersede: launched and dismissed cards are history — never removed', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([ghPr({ number: 2274, title: 'AK-2 y', tipOid: 'aaa1' })]) });
  store.items[0].status = 'dismissed'; // user dismissed it

  // new commits -> the re-review stages; the dismissed card stays as history
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStub([
    ghPr({ number: 2274, title: 'AK-2 y', tipOid: 'bbb2', myLastReviewAt: '2026-08-10T00:00:00Z', tipCommittedDate: '2026-08-11T00:00:00Z' }),
  ]) });
  assert.equal(store.items.length, 2);
  assert.deepEqual(store.items.map((x) => x.status).sort(), ['dismissed', 'pending']);
});

test("supersede: another watcher's pending cards are untouched", async () => {
  state._reset();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };
  const w1 = ghW();
  const w2 = ghW();
  await loop.runGithubWatcherOnce(w1, { ...base, ghClient: ghStub([ghPr({ number: 7, title: 'AK-7 z', tipOid: 'aaa1' })]) });
  await loop.runGithubWatcherOnce(w2, { ...base, ghClient: ghStub([ghPr({ number: 7, title: 'AK-7 z', tipOid: 'bbb2' })]) });
  assert.equal(store.items.length, 2, 'watchers own their cards; no cross-watcher removal');
});

// ---- re-reviews via the reviewed-by query ----------------------------------

test('re-review: a PR I commented on (dropped from review-requested) resurfaces on a push', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  // the orchestrator#2274 shape: submitting a review removed me from requested
  // reviewers, so the PR appears ONLY in the reviewed-by query; the author then
  // pushed past my last review.
  const moved = ghPr({
    number: 2274, title: 'AK-2 y', tipOid: '24488e0',
    myLastReviewAt: '2026-08-11T18:41:47Z', tipCommittedDate: '2026-08-11T19:11:04Z',
  });
  const calls = [];
  const client = {
    async login() { return 'me'; },
    async reviewQueue({ search }) {
      calls.push(search);
      if (search.startsWith('review-requested:@me')) return { total: 0, prs: [] };
      return { total: 1, prs: [moved] };
    },
  };
  const r = await loop.runGithubWatcherOnce(w, {
    ghClient: client,
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  assert.deepEqual(calls, ['review-requested:@me is:open is:pr', 'reviewed-by:@me is:open is:pr']);
  assert.equal(r.staged, 1);
  assert.equal(store.items[0].priority, 2, 'a re-review outranks fresh asks');
});

test('re-review: a PR I reviewed with NO new commits stays invisible', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const unchanged = ghPr({
    number: 9, myLastReviewAt: '2026-08-11T18:00:00Z', tipCommittedDate: '2026-08-11T17:00:00Z',
  });
  const client = {
    async login() { return 'me'; },
    async reviewQueue({ search }) {
      return search.startsWith('reviewed-by') ? { total: 1, prs: [unchanged] } : { total: 0, prs: [] };
    },
  };
  const r = await loop.runGithubWatcherOnce(w, {
    ghClient: client,
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  assert.equal(r.staged, 0);
});

test('re-review: a PR in BOTH queries stages once', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const both = ghPr({ number: 5, title: 'AK-5 z' });
  const client = {
    async login() { return 'me'; },
    async reviewQueue() { return { total: 1, prs: [both] }; },
  };
  const r = await loop.runGithubWatcherOnce(w, {
    ghClient: client,
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  });
  assert.equal(r.staged, 1, 'deduped across the two queries');
});

test('re-review: reReviews:false or a custom search without review-requested runs one query', async () => {
  state._reset();
  const store = memStore();
  const calls = [];
  const client = {
    async login() { return 'me'; },
    async reviewQueue({ search }) { calls.push(search); return { total: 0, prs: [] }; },
  };
  const base = {
    ghClient: client, resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };
  await loop.runGithubWatcherOnce(ghW({ reReviews: false }), base);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await loop.runGithubWatcherOnce(ghW({ search: 'is:open is:pr label:urgent' }), base);
  assert.equal(calls.length, 1, 'nothing to substitute -> no second query');
});

// ---- retiring cards for PRs that already merged -----------------------------

/** ghStub plus the batched state lookup, recording what it was asked about. */
function ghStubWithStates(prs, states, opts) {
  const base = ghStub(prs, opts);
  const asked = [];
  return {
    ...base,
    asked,
    async prStates(refs) {
      asked.push(refs.map((r) => `${r.repo}#${r.number}`));
      return states;
    },
  };
}

test('retire: a pending card whose PR merged is removed once GitHub confirms it', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };

  // pass 1 stages a card for #900
  await loop.runGithubWatcherOnce(w, {
    ...base,
    ghClient: ghStubWithStates([ghPr({ number: 900, title: 'AK-9 thing', tipOid: 'aaa1' })], {}),
  });
  assert.equal(store.items.length, 1);
  store.items[0].ref.watcher = w.name; // the real store keeps ref.watcher; memStore is thin

  // pass 2: the PR merged, so it is gone from BOTH searches and nothing stages —
  // the supersede path can never fire for it
  const gh2 = ghStubWithStates([], { 'acme/java-svc#900': 'MERGED' });
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: gh2 });

  assert.deepEqual(gh2.asked, [['acme/java-svc#900']]);
  assert.equal(store.items.length, 0, 'merged PR card should be retired');
});

test('retire: absence from the queue alone never removes a card (withdrawn review request)', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };

  await loop.runGithubWatcherOnce(w, {
    ...base,
    ghClient: ghStubWithStates([ghPr({ number: 901, title: 'AK-9 thing', tipOid: 'aaa1' })], {}),
  });
  store.items[0].ref.watcher = w.name;

  // dropped out of the search, but still OPEN — the review request was withdrawn
  await loop.runGithubWatcherOnce(w, {
    ...base,
    ghClient: ghStubWithStates([], { 'acme/java-svc#901': 'OPEN' }),
  });
  assert.equal(store.items.length, 1, 'an open PR must keep its card');

  // and an unresolvable PR (lookup failed) likewise keeps it
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStubWithStates([], {}) });
  assert.equal(store.items.length, 1, 'an unresolved lookup must keep its card');
});

test('retire: a PR still in the queue is never even asked about', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const pr900 = ghPr({ number: 900, title: 'AK-9 thing', tipOid: 'aaa1' });
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };

  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStubWithStates([pr900], {}) });
  store.items[0].ref.watcher = w.name;

  // same PR still in the queue on the next pass (nothing new to stage: same tip)
  const gh2 = ghStubWithStates([pr900], { 'acme/java-svc#900': 'MERGED' });
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: gh2 });

  assert.deepEqual(gh2.asked, [], 'a queued PR is live work — no lookup, no retirement');
  assert.equal(store.items.length, 1);
});

test('retire: another watcher\'s cards and non-github cards are left alone', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const foreign = store.add({ source: 'github', ref: { watcher: 'someone-else', prRefs: [{ repo: 'acme/java-svc', number: 900 }] } });
  const manual = store.add({ source: 'manual', ref: { prRefs: [{ repo: 'acme/java-svc', number: 900 }] } });

  await loop.runGithubWatcherOnce(w, {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
    ghClient: ghStubWithStates([], { 'acme/java-svc#900': 'MERGED' }),
  });

  assert.deepEqual(store.items.map((c) => c.id), [foreign.id, manual.id]);
});

test('retire: a failing state lookup does not fail the pass', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };
  await loop.runGithubWatcherOnce(w, {
    ...base,
    ghClient: ghStubWithStates([ghPr({ number: 902, title: 'AK-9 thing', tipOid: 'aaa1' })], {}),
  });
  store.items[0].ref.watcher = w.name;

  const broken = { ...ghStub([]), async prStates() { throw new Error('gh exploded'); } };
  const r = await loop.runGithubWatcherOnce(w, { ...base, ghClient: broken });

  assert.ok(r, 'the pass still returns its summary');
  assert.equal(store.items.length, 1, 'nothing removed on a failed lookup');
});

// --- settled cards: retired from the queue this pass already fetched ---------

test('settle: a card retires once I have reviewed it, with no state lookup at all', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };

  await loop.runGithubWatcherOnce(w, {
    ...base,
    ghClient: ghStubWithStates([ghPr({ number: 910, tipOid: 'aaa1' })], {}),
  });
  assert.equal(store.items.length, 1);
  store.items[0].ref.watcher = w.name;

  // I reviewed it after the tip commit. `reviewed-by:@me` keeps returning it, so
  // absence-based retirement can never see this — the settled pass must.
  const gh2 = ghStubWithStates(
    [ghPr({ number: 910, tipOid: 'aaa1', myLastReviewAt: '2026-08-09T18:00:00Z' })],
    {}
  );
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: gh2 });

  assert.equal(store.items.length, 0, 'reviewed-and-quiet card should settle');
  assert.deepEqual(gh2.asked, [], 'settling costs no prStates call');
});

test('settle: a card retires when another reviewer picks the PR up', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };

  await loop.runGithubWatcherOnce(w, {
    ...base,
    ghClient: ghStubWithStates([ghPr({ number: 911, tipOid: 'aaa1' })], {}),
  });
  store.items[0].ref.watcher = w.name;

  const takenOver = ghPr({
    number: 911, tipOid: 'aaa1',
    otherReviewers: [{ login: 'sneha', state: 'APPROVED', submittedAt: '2026-08-09T18:00:00Z' }],
  });
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStubWithStates([takenOver], {}) });

  assert.equal(store.items.length, 0, 'picked-up card should settle');
});

test('settle: a PR I reviewed and someone else approved is still mine — card stays', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };

  // I reviewed at 10:00, the author pushed at 12:00 — mine to take to closure,
  // and another approval does not release me.
  const live = ghPr({
    number: 912, tipOid: 'bbb2',
    myLastReviewAt: '2026-08-09T10:00:00Z',
    tipCommittedDate: '2026-08-09T12:00:00Z',
    otherReviewers: [{ login: 'sneha', state: 'APPROVED', submittedAt: '2026-08-09T13:00:00Z' }],
  });
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStubWithStates([live], {}) });
  assert.equal(store.items.length, 1, 're-review on a PR I own must still stage');
  store.items[0].ref.watcher = w.name;

  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStubWithStates([live], {}) });
  assert.equal(store.items.length, 1, 'and must not be settled away');
});

test('settle: never touches another watcher, another source, or launched history', async () => {
  state._reset();
  const w = ghW();
  const store = memStore();
  const base = {
    resolveRepo: () => '/c/x', detectStack: () => 'java', candidates: store,
    retention: { threadTtlMs: 1e9, seenTtlMs: 1e9, maxThreads: 50 },
  };

  await loop.runGithubWatcherOnce(w, {
    ...base,
    ghClient: ghStubWithStates([ghPr({ number: 913, tipOid: 'aaa1' })], {}),
  });
  const mine = store.items[0];
  mine.ref.watcher = w.name;
  mine.status = 'launched'; // the user already ran it — that is history, not a card
  store.items.push({
    id: 'other-watcher', status: 'pending', source: 'github',
    ref: { watcher: 'someone-else', prRefs: [{ repo: 'acme/java-svc', number: 913 }] },
  });
  store.items.push({
    id: 'slack-card', status: 'pending', source: 'slack',
    ref: { prRefs: [{ repo: 'acme/java-svc', number: 913 }] },
  });

  const settledPr = ghPr({ number: 913, tipOid: 'aaa1', myLastReviewAt: '2026-08-09T18:00:00Z' });
  await loop.runGithubWatcherOnce(w, { ...base, ghClient: ghStubWithStates([settledPr], {}) });

  assert.deepEqual(store.items.map((c) => c.id).sort(), [mine.id, 'other-watcher', 'slack-card'].sort());
});

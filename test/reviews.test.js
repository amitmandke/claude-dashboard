'use strict';

const test = require('node:test');
const assert = require('node:assert');

const reviews = require('../server/src/services/watchers/reviews');
const repos = require('../server/src/services/watchers/repos');

/** Terse PR factory; every field the module reads has a sane default. */
function pr(over = {}) {
  return {
    repo: 'acme/widgets',
    number: 1,
    title: 'AK-1000: do a thing',
    body: '',
    url: 'https://github.com/acme/widgets/pull/1',
    author: 'someone',
    isDraft: false,
    tipOid: 'abcdef1234567890',
    tipCommittedDate: '2026-08-07T10:00:00Z',
    myLastReviewAt: null,
    ...over,
  };
}

// ---- Jira keys -------------------------------------------------------------

test('extractJiraKeys: finds keys in prose, branches and urls, deduped in order', () => {
  const keys = reviews.extractJiraKeys(
    'AK-70157 [Step 3] based on task/AK-70156-2, part of AK-69031. See AK-70157 again.'
  );
  assert.deepEqual(keys, ['AK-70157', 'AK-70156', 'AK-69031']);
});

test('extractJiraKeys: ignores lowercase and non-key hyphenations', () => {
  assert.deepEqual(reviews.extractJiraKeys('Step-3 rel-67 ak-123 covers utf-8'), []);
});

test('extractJiraKeys: tolerates empty and non-string input', () => {
  assert.deepEqual(reviews.extractJiraKeys(''), []);
  assert.deepEqual(reviews.extractJiraKeys(null), []);
  assert.deepEqual(reviews.extractJiraKeys(undefined), []);
});

// ---- the already-reviewed rule --------------------------------------------

test('needsMyReview: a PR I have never reviewed is included', () => {
  assert.equal(reviews.needsMyReview(pr({ myLastReviewAt: null })), true);
});

test('needsMyReview: reviewed, and new commits landed since -> re-review', () => {
  // the real case: gcp-cloud-proxy#24, review 21:31Z, tip 22:21Z
  const p = pr({ myLastReviewAt: '2026-08-07T21:31:12Z', tipCommittedDate: '2026-08-07T22:21:19Z' });
  assert.equal(reviews.needsMyReview(p), true);
});

test('needsMyReview: reviewed and nothing changed since -> skipped', () => {
  const p = pr({ myLastReviewAt: '2026-08-07T22:30:00Z', tipCommittedDate: '2026-08-07T22:21:19Z' });
  assert.equal(reviews.needsMyReview(p), false);
});

test('needsMyReview: reviewed but tip date unknown -> skipped, never re-nagged on a guess', () => {
  assert.equal(reviews.needsMyReview(pr({ myLastReviewAt: '2026-08-07T22:30:00Z', tipCommittedDate: null })), false);
});

test("needsMyReview: another person's review is irrelevant", () => {
  // no myLastReviewAt, but someone else approved — still mine to do
  const p = pr({ myLastReviewAt: null, othersApproved: true });
  assert.equal(reviews.needsMyReview(p), true);
});

// ---- author policy --------------------------------------------------------

test('isBotAuthor: the [bot] suffix is enough', () => {
  assert.equal(reviews.isBotAuthor('dependabot[bot]'), true);
  assert.equal(reviews.isBotAuthor('renovate[bot]'), true);
  assert.equal(reviews.isBotAuthor('a-human'), false);
});

test('isBotAuthor: an explicit deny entry catches bots without the suffix', () => {
  assert.equal(reviews.isBotAuthor('acme-buildbot', ['acme-buildbot']), true);
  assert.equal(reviews.isBotAuthor('ACME-BuildBot', ['acme-buildbot']), true, 'case-insensitive');
});

test('authorAllowed: includeAuthors inverts the filter, which is the 2nd-watcher seam', () => {
  const only = { includeAuthors: ['dependabot[bot]'] };
  assert.equal(reviews.authorAllowed('dependabot[bot]', only), true);
  assert.equal(reviews.authorAllowed('a-human', only), false);
});

test('selectPrs: drops drafts, bots, and already-reviewed in one pass', () => {
  const list = [
    pr({ number: 1, author: 'human' }),
    pr({ number: 2, author: 'dependabot[bot]' }),
    pr({ number: 3, author: 'human', isDraft: true }),
    pr({ number: 4, author: 'human', myLastReviewAt: '2026-08-09T00:00:00Z' }),
    pr({ number: 5, author: 'human', myLastReviewAt: '2026-08-01T00:00:00Z' }),
  ];
  assert.deepEqual(reviews.selectPrs(list).map((p) => p.number), [1, 5]);
});

test('selectPrs: keeps drafts when skipDrafts is off', () => {
  const list = [pr({ number: 3, isDraft: true })];
  assert.equal(reviews.selectPrs(list, { skipDrafts: false }).length, 1);
});

// ---- story grouping ------------------------------------------------------

test('groupByStory: the real Step2/Step3 pair groups on their shared epic', () => {
  const list = [
    pr({
      repo: 'acme/resource-manager',
      number: 1681,
      title: 'AK-70156 [Step 2] Temporal reservation workflow cutover',
      body: 'Step 2 of AK-69031. Followed by AK-70157.',
    }),
    pr({
      repo: 'acme/resource-manager',
      number: 1683,
      title: 'AK-70157 [Step 3] Retry workflow',
      body: 'Step 3 of AK-69031. Based on AK-70156, not dev.',
    }),
    pr({ repo: 'acme/widgets', number: 7, title: 'AK-99999: unrelated' }),
  ];
  const groups = reviews.groupByStory(list);
  assert.equal(groups.length, 2);
  const story = groups.find((g) => g.prs.length === 2);
  assert.ok(story, 'the two stepped PRs share a group');
  assert.deepEqual(story.prs.map((p) => p.number), [1681, 1683]);
  assert.equal(story.storyKey, 'AK-69031', 'named by the epic both cite');
  const lone = groups.find((g) => g.prs.length === 1);
  assert.equal(lone.storyKey, null, 'a single PR has no story');
});

test('groupByStory: a key cited by only one PR is not a grouping signal', () => {
  const list = [
    pr({ number: 1, title: 'AK-1: alpha' }),
    pr({ number: 2, title: 'AK-2: beta' }),
    pr({ number: 3, title: 'AK-3: gamma' }),
  ];
  const groups = reviews.groupByStory(list);
  assert.equal(groups.length, 3, 'each PR stands alone');
});

test('groupByStory: a key cited by many PRs groups them all under that key', () => {
  const list = [
    pr({ repo: 'acme/a', number: 1, title: 'AK-10 one', body: 'AK-100' }),
    pr({ repo: 'acme/b', number: 2, title: 'AK-20 two', body: 'AK-100' }),
    pr({ repo: 'acme/c', number: 3, title: 'AK-30 three', body: 'AK-100' }),
  ];
  const groups = reviews.groupByStory(list);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].prs.length, 3);
  assert.equal(groups[0].storyKey, 'AK-100');
});

// ---- regressions found by dry-running against the real 48-PR queue --------

test('extractJiraKeys: a standards id is NEVER a key (SHA-256 chained a bot PR into a story)', () => {
  assert.deepEqual(reviews.extractJiraKeys('uses SHA-256 and fixes CVE-2025-1234'), []);
  assert.deepEqual(reviews.extractJiraKeys('AK-7 uses SHA-256'), ['AK-7']);
});

test('extractJiraKeys: an explicit project allowlist rejects everything else', () => {
  const o = { projects: ['AK', 'AKO'] };
  assert.deepEqual(reviews.extractJiraKeys('AK-1 AKO-2 JIRA-3 SHA-256', o), ['AK-1', 'AKO-2']);
});

test('groupByStory: a chain does NOT merge into one storyless group', () => {
  // the real shape: tps#5556 cited both AK-69687 and AK-71158, bridging two
  // unrelated stories; transitive closure produced one group nothing could name.
  const list = [
    pr({ repo: 'acme/oci', number: 21, title: 'AK-70834 a', body: 'AK-69687' }),
    pr({ repo: 'acme/oci', number: 22, title: 'AK-70832 b', body: 'AK-69687' }),
    pr({ repo: 'acme/tps', number: 5556, title: 'AK-70836 c', body: 'AK-69687 and AK-71158' }),
    pr({ repo: 'acme/azure', number: 30, title: 'AK-70958 d', body: 'AK-71158' }),
    pr({ repo: 'acme/tps', number: 5572, title: 'AK-71324 e', body: 'AK-71158' }),
  ];
  const groups = reviews.groupByStory(list);
  assert.ok(groups.every((g) => g.prs.length === 1 || g.storyKey), 'every multi-PR group must be nameable');
  const multi = groups.filter((g) => g.prs.length > 1);
  assert.equal(multi.length, 2, 'two distinct stories, not one blob');
  assert.deepEqual(multi.map((g) => g.storyKey).sort(), ['AK-69687', 'AK-71158']);
  const total = groups.reduce((n, g) => n + g.prs.length, 0);
  assert.equal(total, 5, 'every PR appears exactly once');
});

test('groupByStory: a PR is claimed by only one story (groups stay disjoint)', () => {
  const list = [
    pr({ number: 1, body: 'AK-100' }),
    pr({ number: 2, body: 'AK-100 AK-200' }),
    pr({ number: 3, body: 'AK-200' }),
  ];
  const groups = reviews.groupByStory(list);
  const seen = groups.flatMap((g) => g.prs.map((p) => p.number));
  assert.equal(new Set(seen).size, seen.length, 'no PR in two candidates');
  assert.equal(seen.length, 3);
});

test('isBotAuthor: plain `dependabot` with no [bot] suffix is still a bot', () => {
  assert.equal(reviews.isBotAuthor('dependabot'), true, 'this is what GitHub actually reports');
  assert.equal(reviews.isBotAuthor('renovate'), true);
  assert.equal(reviews.isBotAuthor('github-actions'), true);
  assert.equal(reviews.isBotAuthor('deependra'), false, 'a human whose name starts similarly');
});

test('selectPrs: a real Dependabot bump is excluded by default', () => {
  const bump = pr({ number: 38, author: 'dependabot', title: 'Bump actions/checkout from 6 to 7' });
  assert.deepEqual(reviews.selectPrs([bump]), []);
});

test('groupByStory: an over-cited epic is capped, not collapsed into one candidate', () => {
  const list = Array.from({ length: 7 }, (_, i) =>
    pr({ number: i + 1, title: `AK-${i + 1}: piece`, body: 'part of AK-500' })
  );
  const groups = reviews.groupByStory(list, { maxGroupSize: 3 });
  assert.deepEqual(groups.map((g) => g.prs.length).sort(), [1, 3, 3]);
});

test('groupByStory: output order and membership are stable across calls', () => {
  const list = [
    pr({ repo: 'acme/b', number: 2, body: 'AK-9' }),
    pr({ repo: 'acme/a', number: 1, body: 'AK-9' }),
  ];
  const a = JSON.stringify(reviews.groupByStory(list).map((g) => g.prs.map(reviews.refOf)));
  const b = JSON.stringify(reviews.groupByStory([...list].reverse()).map((g) => g.prs.map(reviews.refOf)));
  assert.equal(a, b, 'input order must not change the grouping');
});

test('groupByStory: empty input yields no groups', () => {
  assert.deepEqual(reviews.groupByStory([]), []);
  assert.deepEqual(reviews.groupByStory(null), []);
});

// ---- dedupe key encodes review state -------------------------------------

test('dedupeKeyFor: unchanged PRs produce the same key (suppressed)', () => {
  const g = { storyKey: null, prs: [pr({ tipOid: 'aaaaaaaaaa' })] };
  assert.equal(reviews.dedupeKeyFor(g), reviews.dedupeKeyFor(g));
});

test('dedupeKeyFor: a new commit produces a new key, so the re-review surfaces', () => {
  const before = reviews.dedupeKeyFor({ storyKey: null, prs: [pr({ tipOid: 'aaaaaaaaaa' })] });
  const after = reviews.dedupeKeyFor({ storyKey: null, prs: [pr({ tipOid: 'bbbbbbbbbb' })] });
  assert.notEqual(before, after);
});

test('dedupeKeyFor: key is order-independent for a group', () => {
  const a = pr({ number: 1, tipOid: '1111111' });
  const b = pr({ number: 2, tipOid: '2222222' });
  assert.equal(
    reviews.dedupeKeyFor({ storyKey: 'AK-1', prs: [a, b] }),
    reviews.dedupeKeyFor({ storyKey: 'AK-1', prs: [b, a] })
  );
});

// ---- prompt rendering ----------------------------------------------------

test('buildPrompt: single PR names its one skill and repo path', () => {
  const g = { storyKey: null, prs: [pr({ repo: 'acme/widgets', number: 5, title: 'AK-1: fix' })] };
  const out = reviews.buildPrompt(g, {
    repoPaths: { 'acme/widgets': '/home/u/code/widgets' },
    skillsByRepo: { 'acme/widgets': 'review-java' },
  });
  assert.match(out, /acme\/widgets#5\s+AK-1: fix/);
  assert.match(out, /Repo acme\/widgets: \/home\/u\/code\/widgets/);
  assert.match(out, /Use the review-java skill\./);
  assert.doesNotMatch(out, /one story/, 'no coherence note for a lone PR');
});

test('buildPrompt: a story spanning Go and Java names BOTH skills', () => {
  const g = {
    storyKey: 'AK-69031',
    prs: [
      pr({ repo: 'acme/java-svc', number: 1 }),
      pr({ repo: 'acme/go-svc', number: 2 }),
    ],
  };
  const out = reviews.buildPrompt(g, {
    repoPaths: { 'acme/java-svc': '/c/java-svc', 'acme/go-svc': '/c/go-svc' },
    skillsByRepo: { 'acme/java-svc': 'review-java', 'acme/go-svc': 'review-go' },
  });
  assert.match(out, /for story AK-69031/);
  assert.match(out, /acme\/java-svc -> review-java/);
  assert.match(out, /acme\/go-svc -> review-go/);
  assert.match(out, /one story/, 'grouped PRs get the coherence instruction');
});

test('buildPrompt: says so when a repo is not checked out and no skill matched', () => {
  const g = { storyKey: null, prs: [pr({ repo: 'acme/mystery', number: 9 })] };
  const out = reviews.buildPrompt(g, {});
  assert.match(out, /not checked out locally/);
  assert.match(out, /pick one before launching/);
});

test('buildPrompt: a custom template controls the layout', () => {
  const g = { storyKey: 'AK-5', prs: [pr(), pr({ number: 2 })] };
  const out = reviews.buildPrompt(g, { template: 'MY BRIEF{story}\n{prs}\n{repos}\n{skills}{coherence}' });
  assert.match(out, /^MY BRIEF for story AK-5/);
});

// ---- planCandidates ------------------------------------------------------

test('planCandidates: end-to-end — filters, groups, renders, caps', () => {
  const list = [
    pr({ repo: 'acme/rm', number: 1681, title: 'AK-70156 [Step 2]', body: 'of AK-69031' }),
    pr({ repo: 'acme/rm', number: 1683, title: 'AK-70157 [Step 3]', body: 'of AK-69031' }),
    pr({ repo: 'acme/go-svc', number: 40, title: 'AK-1: solo' }),
    pr({ repo: 'acme/rm', number: 99, author: 'dependabot[bot]', title: 'Bump x' }),
  ];
  const out = reviews.planCandidates(list, {
    resolveRepo: (r) => ({ 'acme/rm': '/c/rm', 'acme/go-svc': '/c/go-svc' })[r] || null,
    skillForRepo: (r) => (r === 'acme/go-svc' ? 'review-go' : 'review-java'),
  });

  assert.equal(out.selected, 3, 'the bot PR is gone');
  assert.equal(out.candidates.length, 2, 'story grouped + solo');

  const story = out.candidates.find((c) => c.storyKey === 'AK-69031');
  assert.equal(story.cwd, '/c/rm');
  assert.equal(story.skill, 'review-java', 'single-repo group carries its skill');
  assert.deepEqual(story.prRefs, [
    { repo: 'acme/rm', number: 1681 },
    { repo: 'acme/rm', number: 1683 },
  ]);
  assert.match(story.reason, /story AK-69031 \(2 PRs\)/);

  const solo = out.candidates.find((c) => c.storyKey === null);
  assert.equal(solo.skill, 'review-go');
  assert.match(solo.reason, /acme\/go-svc#40/);
});

test('planCandidates: a multi-repo group carries no single skill, prompt names them', () => {
  const list = [
    pr({ repo: 'acme/java-svc', number: 1, body: 'AK-7' }),
    pr({ repo: 'acme/go-svc', number: 2, body: 'AK-7' }),
  ];
  const out = reviews.planCandidates(list, {
    resolveRepo: (r) => `/c/${r.split('/')[1]}`,
    skillForRepo: (r) => (r.includes('go') ? 'review-go' : 'review-java'),
  });
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].skill, '', 'ambiguous — must not guess one');
  assert.match(out.candidates[0].prompt, /review-go/);
  assert.match(out.candidates[0].prompt, /review-java/);
});

test('planCandidates: an already-staged dedupe key is suppressed, not counted against the cap', () => {
  // distinct keys, so these are three separate stories rather than one group
  const list = [
    pr({ number: 1, title: 'AK-1: a' }),
    pr({ number: 2, title: 'AK-2: b' }),
    pr({ number: 3, title: 'AK-3: c' }),
  ];
  const first = reviews.planCandidates(list, { maxStagePerTick: 10 });
  assert.equal(first.candidates.length, 3);
  const staged = new Set(first.candidates.map((c) => c.dedupeKey));
  const second = reviews.planCandidates(list, { isStaged: (k) => staged.has(k) });
  assert.equal(second.candidates.length, 0);
  assert.equal(second.suppressed, 3);
});

test('planCandidates: maxStagePerTick bounds the first run', () => {
  const list = Array.from({ length: 12 }, (_, i) => pr({ number: i + 1, title: `AK-${i}: x` }));
  const out = reviews.planCandidates(list, { maxStagePerTick: 5 });
  assert.equal(out.candidates.length, 5);
  assert.equal(out.groups, 12, 'the rest are not lost, just not staged this tick');
});

test('planCandidates: falls back to defaultCwd when the repo is not checked out', () => {
  const out = reviews.planCandidates([pr({ repo: 'acme/nope', number: 1 })], { defaultCwd: '/c/fallback' });
  assert.equal(out.candidates[0].cwd, '/c/fallback');
  assert.doesNotMatch(out.candidates[0].reason, /pick a repo/);
});

test('planCandidates: with no cwd at all the reason tells you to pick one', () => {
  const out = reviews.planCandidates([pr({ repo: 'acme/nope', number: 1 })], {});
  assert.match(out.candidates[0].reason, /pick a repo before launch/);
});

test('priorityFor: re-reviews outrank grouped stories, which outrank lone PRs', () => {
  assert.equal(reviews.priorityFor({ prs: [pr({ myLastReviewAt: '2026-01-01T00:00:00Z' })] }), 2);
  assert.equal(reviews.priorityFor({ prs: [pr(), pr({ number: 2 })] }), 1);
  assert.equal(reviews.priorityFor({ prs: [pr()] }), 0);
});

// ---- stack detection -----------------------------------------------------

test('detectStack: go.mod -> go, maven/gradle -> java, otherwise null', () => {
  const only = (name) => ({ exists: (p) => p.endsWith(name) });
  assert.equal(repos.detectStack('/c/x', only('go.mod')), 'go');
  assert.equal(repos.detectStack('/c/x', only('pom.xml')), 'java');
  assert.equal(repos.detectStack('/c/x', only('build.gradle')), 'java');
  assert.equal(repos.detectStack('/c/x', only('build.gradle.kts')), 'java');
  assert.equal(repos.detectStack('/c/x', { exists: () => false }), null);
  assert.equal(repos.detectStack('', { exists: () => true }), null);
});

test('detectStack: go wins when a repo carries both markers', () => {
  assert.equal(repos.detectStack('/c/x', { exists: () => true }), 'go');
});

test('a story whose repos all share one skill states it once and carries it', () => {
  // the real AK-71011: one netty security bump across four Java services
  const list = ['aws-resource-gateway', 'credentials-java', 'network-alerts', 'web-apigw'].map((r, i) =>
    pr({ repo: `acme/${r}`, number: 300 + i, title: `AK-7108${i}: Bump netty`, body: 'AK-71011' })
  );
  const out = reviews.planCandidates(list, {
    resolveRepo: (r) => `/c/${r.split('/')[1]}`,
    skillForRepo: () => 'review-java',
  });
  assert.equal(out.candidates.length, 1);
  const c = out.candidates[0];
  assert.equal(c.storyKey, 'AK-71011');
  assert.equal(c.skill, 'review-java', 'unambiguous across repos -> carry it');
  assert.match(c.prompt, /Use the review-java skill\./);
  assert.doesNotMatch(c.prompt, /Skills to use/, 'not listed once per repo');
});

test('a genuinely mixed Go+Java story carries no skill and lists them per repo', () => {
  const list = [
    pr({ repo: 'acme/java-svc', number: 1, body: 'AK-7' }),
    pr({ repo: 'acme/go-svc', number: 2, body: 'AK-7' }),
  ];
  const out = reviews.planCandidates(list, {
    resolveRepo: (r) => `/c/${r.split('/')[1]}`,
    skillForRepo: (r) => (r.includes('go') ? 'review-go' : 'review-java'),
  });
  assert.equal(out.candidates[0].skill, '');
  assert.match(out.candidates[0].prompt, /Skills to use/);
});

test('a partly-unresolvable story carries no skill even if the known repos agree', () => {
  const list = [
    pr({ repo: 'acme/java-svc', number: 1, body: 'AK-8' }),
    pr({ repo: 'acme/mystery', number: 2, body: 'AK-8' }),
  ];
  const out = reviews.planCandidates(list, {
    resolveRepo: (r) => (r === 'acme/mystery' ? null : '/c/java-svc'),
    skillForRepo: (r) => (r === 'acme/mystery' ? '' : 'review-java'),
  });
  assert.equal(out.candidates[0].skill, '', 'must not apply one repo\'s skill to an unknown one');
});

// ---- gh.js response parsing (the rest of that module is pure I/O) ---------

const gh = require('../server/src/services/watchers/gh');

test('parseQueue: flattens the GraphQL shape into flat PRs', () => {
  const { total, prs } = gh.parseQueue(
    JSON.stringify({
      data: {
        search: {
          issueCount: 2,
          nodes: [
            {
              number: 1683,
              title: 'AK-70157 [Step 3]',
              body: 'of AK-69031',
              isDraft: false,
              url: 'https://github.com/acme/rm/pull/1683',
              updatedAt: '2026-08-10T01:00:00Z',
              author: { login: 'camjrichards' },
              repository: { nameWithOwner: 'acme/rm' },
              commits: { nodes: [{ commit: { oid: 'deadbeefcafe', committedDate: '2026-08-09T10:00:00Z' } }] },
              reviews: { nodes: [{ submittedAt: '2026-08-08T10:00:00Z', state: 'CHANGES_REQUESTED' }] },
            },
            {},
          ],
        },
      },
    })
  );
  assert.equal(total, 2);
  assert.equal(prs.length, 1, 'a node with no repository/number is dropped');
  assert.deepEqual(prs[0], {
    repo: 'acme/rm',
    number: 1683,
    title: 'AK-70157 [Step 3]',
    body: 'of AK-69031',
    url: 'https://github.com/acme/rm/pull/1683',
    author: 'camjrichards',
    isDraft: false,
    updatedAt: '2026-08-10T01:00:00Z',
    tipOid: 'deadbeefcafe',
    tipCommittedDate: '2026-08-09T10:00:00Z',
    myLastReviewAt: '2026-08-08T10:00:00Z',
    myLastReviewState: 'CHANGES_REQUESTED',
  });
});

test('parseQueue: a PENDING review (never submitted) reads as not reviewed', () => {
  const { prs } = gh.parseQueue(
    JSON.stringify({
      data: {
        search: {
          issueCount: 1,
          nodes: [
            {
              number: 1,
              repository: { nameWithOwner: 'acme/x' },
              commits: { nodes: [] },
              reviews: { nodes: [{ submittedAt: null, state: 'PENDING' }] },
            },
          ],
        },
      },
    })
  );
  assert.equal(prs[0].myLastReviewAt, null);
  assert.equal(reviews.needsMyReview(prs[0]), true, 'an unsubmitted draft review is not a review');
});

test('parseQueue: surfaces GraphQL errors and bad payloads as thrown messages', () => {
  assert.throws(() => gh.parseQueue('not json'), /non-JSON/);
  assert.throws(() => gh.parseQueue(JSON.stringify({ errors: [{ message: 'Bad credentials' }] })), /Bad credentials/);
  assert.throws(() => gh.parseQueue(JSON.stringify({ data: {} })), /unexpected response shape/);
});

// ---- digest ('all') group mode ---------------------------------------------

test("groupMode 'all': the whole selection folds into one digest candidate", () => {
  const list = [
    pr({ repo: 'acme/aws-proxy', number: 38, author: 'dependabot', title: 'Bump actions/checkout from 6 to 7' }),
    pr({ repo: 'acme/pan-mon', number: 81, author: 'dependabot', title: 'Bump the patch-updates group' }),
    pr({ repo: 'acme/web-apigw', number: 574, author: 'renovate', title: 'Bump spring-retry' }),
  ];
  const out = reviews.planCandidates(list, {
    groupMode: 'all',
    includeAuthors: ['dependabot', 'renovate'],
    resolveRepo: (r) => `/c/${r.split('/')[1]}`,
    skillForRepo: () => 'review-java',
  });
  assert.equal(out.candidates.length, 1);
  const d = out.candidates[0];
  assert.equal(d.digest, true);
  assert.equal(d.prRefs.length, 3);
  assert.match(d.reason, /3 PRs in one batch/);
  assert.equal(d.priority, 0, 'a routine batch never outranks real reviews');
  assert.match(d.prompt, /own merits/, 'digest coherence note, not the story one');
  assert.doesNotMatch(d.prompt, /one story/);
});

test("groupMode 'all': queue change changes the dedupe key; same queue suppresses", () => {
  const list = [pr({ number: 1, tipOid: 'aaa1111' }), pr({ number: 2, tipOid: 'bbb2222' })];
  const k1 = reviews.planCandidates(list, { groupMode: 'all' }).candidates[0].dedupeKey;
  const k1b = reviews.planCandidates([...list].reverse(), { groupMode: 'all' }).candidates[0].dedupeKey;
  assert.equal(k1, k1b, 'order-independent');
  const k2 = reviews.planCandidates([...list, pr({ number: 3, tipOid: 'ccc3333' })], { groupMode: 'all' })
    .candidates[0].dedupeKey;
  assert.notEqual(k1, k2, 'a new bump re-stages the digest');
});

test("groupMode 'all': empty selection stages nothing", () => {
  const out = reviews.planCandidates([pr({ isDraft: true })], { groupMode: 'all' });
  assert.equal(out.candidates.length, 0);
});

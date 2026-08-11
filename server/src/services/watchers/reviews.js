'use strict';

/**
 * Pure logic for the GitHub review watcher — selection, story grouping, skill
 * choice, prompt rendering and dedupe keys. No I/O: `gh.js` fetches, this module
 * decides, `index.js` stages. Everything here is unit-tested.
 *
 * Why this producer exists at all: a PR-review queue cannot be read off Slack.
 * A channel subscribed to an org receives repo *activity* with no reviewer
 * information, and the one personally-addressed signal ("X requested your
 * review") is a GitHub DM that a bot token structurally cannot read. GitHub
 * answers the question directly, so we ask it directly.
 */

/**
 * Jira-style issue keys (`AK-70157`). Anchored on word boundaries so a key inside
 * a branch name (`task/AK-70156-2`) or a URL still matches, and uppercase-only so
 * prose like `Step-3` never looks like a key.
 */
const JIRA_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/**
 * Prefixes that look exactly like a Jira project but are not. This is not
 * pedantry: `SHA-256` appears both in a real PR body and in Dependabot's release
 * notes, and that single coincidence chained an unrelated version bump into a
 * genuine multi-repo story. A standards identifier must never be a grouping
 * signal. Prefer setting `jiraProjects` explicitly — then this list is unused.
 */
const NON_JIRA_PREFIXES = new Set([
  'SHA', 'MD5', 'CVE', 'GHSA', 'RFC', 'ISO', 'IEC', 'ANSI', 'UTF', 'ASCII',
  'AES', 'RSA', 'ECDSA', 'TLS', 'SSL', 'HTTP', 'HTTPS', 'IPV', 'IP', 'TCP', 'UDP',
  'JDK', 'JEP', 'JSR', 'CVSS', 'CWE', 'NIST', 'SOC', 'PCI', 'FIPS', 'GDPR',
  'X', 'EC2', 'S3', 'K8S', 'CIS', 'OWASP', 'SPDX', 'SEMVER', 'PEP',
]);

const DEFAULT_MAX_GROUP_SIZE = 5;

/**
 * Bot logins that carry no `[bot]` suffix. GitHub reports Dependabot's author as
 * plain `dependabot` on these PRs, so suffix matching alone let every dependency
 * bump through the filter.
 */
const KNOWN_BOT_LOGINS = new Set([
  'dependabot', 'dependabot-preview', 'renovate', 'renovatebot',
  'github-actions', 'greenkeeper', 'snyk-bot', 'imgbot', 'allcontributors',
]);

const DEFAULT_PROMPT_TEMPLATE = [
  'Review the following PR(s){story}:',
  '',
  '{prs}',
  '',
  '{repos}',
  '{skills}',
  '{coherence}',
].join('\n');

/**
 * Unique Jira keys in a blob of text, in first-seen order.
 *
 * `projects` is an explicit allowlist of project prefixes (`['AK','AKO']`) — the
 * precise option, and the recommended one. With no allowlist we fall back to
 * rejecting known standards prefixes (see NON_JIRA_PREFIXES).
 */
function extractJiraKeys(text, { projects = [] } = {}) {
  if (!text || typeof text !== 'string') return [];
  const allow = projects.length ? new Set(projects.map((p) => String(p).toUpperCase())) : null;
  const out = [];
  for (const key of text.match(JIRA_KEY_RE) || []) {
    const prefix = key.slice(0, key.indexOf('-'));
    if (allow ? !allow.has(prefix) : NON_JIRA_PREFIXES.has(prefix)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Every Jira key a PR references, from its title and body together. */
function storyKeysOf(pr, opts = {}) {
  return extractJiraKeys(`${(pr && pr.title) || ''}\n${(pr && pr.body) || ''}`, opts);
}

/** `owner/repo#123` — the stable human identity of a PR. */
function refOf(pr) {
  return `${pr.repo}#${pr.number}`;
}

/**
 * Does this PR still want *my* review?
 *
 * `--review-requested=@me` does NOT exclude PRs I have already reviewed (2 of 27
 * in the real queue were), so filter explicitly:
 *
 *   - never reviewed by me      -> include
 *   - reviewed, new commits     -> include (this is the re-review case)
 *   - reviewed, nothing new     -> skip
 *
 * Other reviewers are deliberately never consulted: whether someone else
 * approved says nothing about whether my review is outstanding.
 */
function needsMyReview(pr) {
  if (!pr || !pr.myLastReviewAt) return true;
  if (!pr.tipCommittedDate) return false; // reviewed, and we can't prove anything changed
  return pr.tipCommittedDate > pr.myLastReviewAt; // ISO-8601 Z strings sort lexicographically
}

/**
 * True for authors that are bots. Three tests, because one is not enough: the
 * `[bot]` suffix, a known bot login *without* the suffix (GitHub reports
 * Dependabot as plain `dependabot` on dependency PRs — suffix-only matching let
 * every bump through), and the watcher's own deny list.
 */
function isBotAuthor(login, excludeAuthors = []) {
  const l = String(login || '').toLowerCase();
  if (!l) return false;
  if (l.endsWith('[bot]')) return true;
  if (KNOWN_BOT_LOGINS.has(l.replace(/\[bot\]$/, ''))) return true;
  return excludeAuthors.some((a) => String(a).toLowerCase() === l);
}

/**
 * Apply the watcher's author policy. `includeAuthors` (when non-empty) is an
 * allowlist — that is the seam that lets a second watcher batch exactly the bot
 * PRs the primary one excludes, with no code change.
 */
function authorAllowed(login, { excludeAuthors = [], includeAuthors = [] } = {}) {
  const l = String(login || '').toLowerCase();
  if (includeAuthors.length) return includeAuthors.some((a) => String(a).toLowerCase() === l);
  return !isBotAuthor(l, excludeAuthors);
}

/** Selection: drafts, author policy, then the already-reviewed rule. */
function selectPrs(prs, { excludeAuthors = [], includeAuthors = [], skipDrafts = true } = {}) {
  return (prs || []).filter((pr) => {
    if (!pr || !pr.repo || !pr.number) return false;
    if (skipDrafts && pr.isDraft) return false;
    if (!authorAllowed(pr.author, { excludeAuthors, includeAuthors })) return false;
    return needsMyReview(pr);
  });
}

/** Deterministic chunking so an oversized story splits the same way every poll. */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Group PRs that belong to one story, so a multi-PR story is reviewed in a
 * single session where the pieces can be judged against each other.
 *
 * Two PRs join when they share a Jira key — connected components over keys that
 * appear in at least TWO of the queued PRs. Requiring two is what stops a PR's
 * own unique ticket from being a grouping signal, while still catching the real
 * pattern: `#1681` ([Step 2]) and `#1683` ([Step 3]) both cite epic `AK-69031`.
 *
 * Note the signal deliberately is NOT branch stacking: both of those PRs target
 * `dev`, because the author intends to rebase later. Base refs would miss it.
 *
 * Groups are capped (`maxGroupSize`) so one very widely-cited epic can't collapse
 * the whole queue into a single unreviewable candidate.
 */
function groupByStory(prs, { maxGroupSize = DEFAULT_MAX_GROUP_SIZE, projects = [] } = {}) {
  const list = prs || [];
  if (!list.length) return [];

  const membersByKey = new Map();
  list.forEach((pr, i) => {
    for (const k of storyKeysOf(pr, { projects })) {
      if (!membersByKey.has(k)) membersByKey.set(k, []);
      membersByKey.get(k).push(i);
    }
  });

  // Key-centric, NOT transitive closure. A chain (A–B share K1, B–C share K2)
  // is not one story: it produced a five-PR group whose members had no key in
  // common, so nothing could name it. Instead each candidate group IS the set of
  // PRs citing one key — which guarantees every multi-PR group has a storyKey.
  // Strongest key first (most members, then lexicographic) so the assignment and
  // therefore the dedupe key are stable across polls.
  const ranked = [...membersByKey.entries()]
    .filter(([, m]) => m.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const groups = [];
  const claimed = new Set();
  const byPrOrder = (a, b) => {
    const pa = list[a];
    const pb = list[b];
    return pa.repo === pb.repo ? pa.number - pb.number : pa.repo.localeCompare(pb.repo);
  };

  for (const [key, members] of ranked) {
    const free = members.filter((i) => !claimed.has(i)).sort(byPrOrder);
    if (free.length < 2) continue; // the rest of this story is already spoken for
    for (const part of chunk(free, Math.max(2, maxGroupSize))) {
      if (part.length < 2) {
        // a trailing remainder of one is a lone PR, not a story
        groups.push({ storyKey: null, prs: [list[part[0]]] });
      } else {
        groups.push({ storyKey: key, prs: part.map((i) => list[i]) });
      }
      part.forEach((i) => claimed.add(i));
    }
  }

  list.forEach((pr, i) => {
    if (!claimed.has(i)) groups.push({ storyKey: null, prs: [pr] });
  });

  return groups.sort((a, b) => refOf(a.prs[0]).localeCompare(refOf(b.prs[0])));
}

/**
 * Dedupe key that encodes *review state*, not just identity: the group plus each
 * PR's tip commit. New commits produce a new key, so a re-review surfaces as a
 * fresh candidate; an unchanged PR produces the key already on record and is
 * suppressed whatever that candidate's status became. That is what makes "skip
 * what I've reviewed" and "show it again when it changes" one rule.
 */
function dedupeKeyFor(group) {
  const tips = group.prs
    .map((p) => `${refOf(p)}@${String(p.tipOid || '').slice(0, 7)}`)
    .sort();
  const head = group.storyKey || refOf(group.prs[0]);
  return `gh:${head}:${tips.join('+')}`;
}

/** Highest-signal repo for the group's `cwd`: most PRs, then alphabetical. */
function primaryRepoOf(group) {
  const counts = new Map();
  for (const p of group.prs) counts.set(p.repo, (counts.get(p.repo) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * Render the launch prompt. Deliberately a LIGHT hand-off — which PRs, which
 * story, which repo paths, which skill applies to each. The investigation smarts
 * belong in the skill, which runs fresh at launch; pre-baking them here would
 * duplicate the launched session's work and go stale as the PR moves.
 */
function buildPrompt(group, { template = DEFAULT_PROMPT_TEMPLATE, repoPaths = {}, skillsByRepo = {} } = {}) {
  const prLines = group.prs
    .map((p) => `  ${refOf(p)}  ${(p.title || '').trim()}`)
    .join('\n');

  const repos = [...new Set(group.prs.map((p) => p.repo))];
  const repoLines = repos
    .map((r) => (repoPaths[r] ? `Repo ${r}: ${repoPaths[r]}` : `Repo ${r}: (not checked out locally)`))
    .join('\n');

  // One skill per repo, so a story spanning Go and Java names both — but a story
  // whose repos all share one skill (four Java services taking the same security
  // bump) should say it once, not once per repo.
  const pairs = repos.map((r) => [r, skillsByRepo[r] || '']).filter(([, s]) => s);
  const distinct = [...new Set(pairs.map(([, s]) => s))];
  let skills;
  if (!pairs.length) skills = 'No review skill matched these repos — pick one before launching.';
  else if (distinct.length === 1 && pairs.length === repos.length) skills = `Use the ${distinct[0]} skill.`;
  else skills = ['Skills to use:', ...pairs.map(([r, s]) => `  ${r} -> ${s}`)].join('\n');

  return template
    .replace('{story}', group.storyKey ? ` for story ${group.storyKey}` : '')
    .replace('{prs}', prLines)
    .replace('{repos}', repoLines)
    .replace('{skills}', skills)
    .replace(
      '{coherence}',
      group.digest
        ? '\nThese are batched routine PRs — review and merge each on its own merits.'
        : group.prs.length > 1
          ? '\nThese PRs are part of one story — review them together for coherence.'
          : ''
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** confidence-free priority: a grouped story outranks a lone PR, re-reviews first. */
function priorityFor(group) {
  if (group.digest) return 0; // routine batch — never outranks real review work
  const isReReview = group.prs.some((p) => p.myLastReviewAt);
  if (isReReview) return 2;
  return group.prs.length > 1 ? 1 : 0;
}

/**
 * Full plan for one poll: select, group, cap, and render each group into the
 * shape `candidates.add` wants. `alreadyStaged` is consulted here (not after
 * rendering) so the per-tick cap counts only genuinely new work.
 */
function planCandidates(
  prs,
  {
    excludeAuthors = [],
    includeAuthors = [],
    skipDrafts = true,
    maxGroupSize = DEFAULT_MAX_GROUP_SIZE,
    maxStagePerTick = 5,
    projects = [],
    groupMode = 'story',
    template = DEFAULT_PROMPT_TEMPLATE,
    resolveRepo = () => null,
    skillForRepo = () => '',
    isStaged = () => false,
    defaultCwd = '',
  } = {}
) {
  const selected = selectPrs(prs, { excludeAuthors, includeAuthors, skipDrafts });
  // 'all' folds the entire selection into ONE digest group — what a bot-PR
  // watcher wants: dependency bumps share no story key, so story grouping would
  // hand back one candidate per bump, defeating the batch. 'story' is the
  // human-review default.
  const groups =
    groupMode === 'all'
      ? selected.length
        ? [{ storyKey: null, digest: true, prs: [...selected].sort((a, b) =>
            a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo)) }]
        : []
      : groupByStory(selected, { maxGroupSize, projects });

  const out = [];
  let suppressed = 0;
  for (const group of groups) {
    const dedupeKey = dedupeKeyFor(group);
    if (isStaged(dedupeKey)) {
      suppressed++;
      continue;
    }
    if (out.length >= maxStagePerTick) break;

    const repos = [...new Set(group.prs.map((p) => p.repo))];
    const repoPaths = {};
    const skillsByRepo = {};
    for (const r of repos) {
      const dir = resolveRepo(r);
      if (dir) repoPaths[r] = dir;
      const s = skillForRepo(r, dir);
      if (s) skillsByRepo[r] = s;
    }

    const primary = primaryRepoOf(group);
    const cwd = repoPaths[primary] || defaultCwd || '';
    // The candidate carries a skill only when it is unambiguous — one repo, or
    // several that all resolve to the same skill (a security bump across four
    // Java services). A genuinely mixed Go+Java story carries none, and the
    // prompt names them per repo instead of the card guessing.
    const skillsPresent = [...new Set(repos.map((r) => skillsByRepo[r]).filter(Boolean))];
    const skill = skillsPresent.length === 1 && repos.every((r) => skillsByRepo[r]) ? skillsPresent[0] : '';

    out.push({
      dedupeKey,
      cwd,
      skill,
      prompt: buildPrompt(group, { template, repoPaths, skillsByRepo }),
      reason:
        (group.digest
          ? `GitHub review requested — ${group.prs.length} PRs in one batch`
          : group.storyKey
            ? `GitHub review requested — story ${group.storyKey} (${group.prs.length} PRs)`
            : `GitHub review requested — ${refOf(group.prs[0])}`) + (cwd ? '' : ' [pick a repo before launch]'),
      priority: priorityFor(group),
      prRefs: group.prs.map((p) => ({ repo: p.repo, number: p.number })),
      storyKey: group.storyKey,
      digest: !!group.digest,
      url: group.prs.length === 1 ? group.prs[0].url || '' : '',
    });
  }

  return { candidates: out, groups: groups.length, selected: selected.length, suppressed };
}

module.exports = {
  extractJiraKeys,
  storyKeysOf,
  refOf,
  needsMyReview,
  isBotAuthor,
  authorAllowed,
  selectPrs,
  groupByStory,
  dedupeKeyFor,
  primaryRepoOf,
  buildPrompt,
  priorityFor,
  planCandidates,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_MAX_GROUP_SIZE,
};

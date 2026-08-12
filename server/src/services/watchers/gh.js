'use strict';

/**
 * GitHub access for the review watcher, via the `gh` CLI the user is already
 * authenticated with — so there is no token to store, no OAuth app, and no new
 * secret in config. Coverage-excluded like `slack.js`: this file is pure I/O and
 * the pipeline that consumes it (`reviews.js`) is unit-tested against injected
 * data.
 *
 * The whole queue arrives in ONE GraphQL call — PR identity, body (needed for
 * story grouping), draft state, author, the tip commit, and my own last review.
 * A REST/`gh pr view` loop would be one subprocess per PR (~48 of them, several
 * seconds each) for the same information.
 */

const { execFile } = require('child_process');

const DEFAULT_BIN = 'gh';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_BUFFER = 8 * 1024 * 1024; // 48 PRs with bodies comfortably exceeds the default

const QUEUE_QUERY = `
query($q: String!, $me: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) {
    issueCount
    nodes {
      ... on PullRequest {
        number
        title
        body
        isDraft
        url
        updatedAt
        author { login }
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { oid committedDate } } }
        reviews(author: $me, last: 1) { nodes { submittedAt state } }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT], last: 20) {
          nodes {
            __typename
            ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
            ... on ReviewRequestRemovedEvent { createdAt requestedReviewer { ... on User { login } } }
          }
        }
      }
    }
  }
}`;

/**
 * Run `gh` and resolve its stdout, rejecting with a useful message on failure.
 *
 * `allowPartial` keeps a response that GitHub answered only partly. A multi-PR
 * GraphQL query with one unresolvable repo returns real data for the rest AND an
 * `errors` array — and `gh` exits non-zero for it. Without this, one repo you
 * lost access to would reject the whole call.
 */
function runGh(args, { bin = DEFAULT_BIN, timeoutMs = DEFAULT_TIMEOUT_MS, allowPartial = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        if (allowPartial && String(stdout || '').includes('{')) return resolve(stdout);
        const detail = (stderr || err.message || '').trim().split('\n')[0];
        // ENOENT here means `gh` isn't installed/on PATH — say so plainly rather
        // than surfacing a bare errno, since the fix is a one-liner for the user.
        if (err.code === 'ENOENT') return reject(new Error(`gh CLI not found (${bin})`));
        return reject(new Error(detail || 'gh failed'));
      }
      resolve(stdout);
    });
  });
}

/**
 * When was *my* review last asked for — the timestamp of the newest
 * REVIEW_REQUESTED_EVENT naming me.
 *
 * There is no field for this: `reviewRequests` lists who is currently on the
 * hook but carries no timestamp, so the timeline is the only source. Two details
 * that matter:
 *
 *   - a *team* request has no `login` (the inline fragment yields `{}`) and is
 *     deliberately not a personal ask — only my own login counts;
 *   - if my newest event is a REMOVAL, the answer is null. A request that was
 *     withdrawn must not read as outstanding, or the `reviewed-by:@me` query
 *     would resurface a PR nobody is waiting on me for.
 */
function myReviewRequestedAt(n, me) {
  const login = String(me || '').toLowerCase();
  if (!login) return null;
  let latest = null;
  for (const ev of (n.timelineItems && n.timelineItems.nodes) || []) {
    if (!ev || !ev.createdAt) continue;
    const who = (ev.requestedReviewer && ev.requestedReviewer.login) || '';
    if (String(who).toLowerCase() !== login) continue;
    if (!latest || ev.createdAt > latest.createdAt) latest = ev;
  }
  if (!latest) return null;
  return latest.__typename === 'ReviewRequestRemovedEvent' ? null : latest.createdAt;
}

/**
 * Flatten one GraphQL node into the flat shape `reviews.js` expects. A review
 * with a null `submittedAt` is PENDING (started, never submitted) and must read
 * as "not reviewed", which falling through to null achieves.
 */
function normalizeNode(n, me) {
  if (!n || !n.repository || !n.number) return null;
  const commit = ((n.commits && n.commits.nodes) || [])[0];
  const review = ((n.reviews && n.reviews.nodes) || [])[0];
  return {
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title || '',
    body: n.body || '',
    url: n.url || '',
    author: (n.author && n.author.login) || '',
    isDraft: !!n.isDraft,
    updatedAt: n.updatedAt || null,
    tipOid: (commit && commit.commit && commit.commit.oid) || '',
    tipCommittedDate: (commit && commit.commit && commit.commit.committedDate) || null,
    myLastReviewAt: (review && review.submittedAt) || null,
    myLastReviewState: (review && review.state) || '',
    myReviewRequestedAt: myReviewRequestedAt(n, me),
  };
}

/**
 * One aliased GraphQL query asking "what happened to these PRs?" — used to decide
 * whether a candidate on the board is for a PR that has since merged or closed.
 * Aliases (`p0`, `p1`, …) let a single call cover the whole suspect list; the
 * alternative is a `gh pr view` subprocess per PR.
 *
 * Exported for tests. `repo` is `owner/name`.
 */
function buildStatesQuery(refs) {
  const parts = refs.map((r, i) => {
    const [owner, name] = String(r.repo).split('/');
    return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) ` +
           `{ pullRequest(number: ${Number(r.number)}) { state } }`;
  });
  return `query {\n  ${parts.join('\n  ')}\n}`;
}

/**
 * Take the leading JSON object out of `gh`'s stdout.
 *
 * On a partial GraphQL failure `gh` prints the JSON body and then appends its own
 * one-line complaint (`gh: Could not resolve to a Repository…`), which makes a
 * plain JSON.parse fail on an otherwise perfectly usable answer. Brace-counting
 * (string-aware, so a `}` inside a PR title can't fool it) is what survives that.
 */
function extractJson(stdout) {
  const s = String(stdout || '');
  const start = s.indexOf('{');
  if (start === -1) throw new Error('no JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  throw new Error('truncated JSON');
}

/**
 * Exported for tests: read the aliased response back into `repo#number -> state`.
 *
 * A missing or null alias is left OUT of the map rather than guessed at — the
 * caller must treat "unknown" as "leave the candidate alone", since deleting
 * someone's board item on a failed lookup is the one unrecoverable mistake here.
 */
function parseStates(stdout, refs) {
  let payload;
  try {
    payload = JSON.parse(extractJson(stdout));
  } catch {
    throw new Error('gh api graphql: non-JSON response');
  }
  // Partial errors are normal here (a repo you lost access to); keep whatever
  // resolved instead of failing the whole pass.
  const data = payload.data || {};
  const out = {};
  refs.forEach((r, i) => {
    const node = data[`p${i}`];
    const state = node && node.pullRequest && node.pullRequest.state;
    if (state) out[`${r.repo}#${r.number}`] = state;
  });
  return out;
}

/** Exported for tests: parse a raw `gh api graphql` response into PRs. */
function parseQueue(stdout, me) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error('gh api graphql: non-JSON response');
  }
  if (payload.errors && payload.errors.length) {
    throw new Error(`gh api graphql: ${payload.errors[0].message}`);
  }
  const search = payload.data && payload.data.search;
  if (!search) throw new Error('gh api graphql: unexpected response shape');
  return {
    total: search.issueCount || 0,
    prs: (search.nodes || []).map((n) => normalizeNode(n, me)).filter(Boolean),
  };
}

function createClient({ bin = DEFAULT_BIN, timeoutMs = DEFAULT_TIMEOUT_MS, run = runGh } = {}) {
  return {
    /** The authenticated login, used to scope the "my review" lookup. */
    async login() {
      const out = await run(['api', 'user', '-q', '.login'], { bin, timeoutMs });
      const login = String(out || '').trim();
      if (!login) throw new Error('gh api user: empty login (is `gh auth login` done?)');
      return login;
    },

    /**
     * PRs whose review is requested from `login`, open, newest first. `search`
     * overrides the query for a differently-scoped watcher (e.g. one restricted
     * to an org, or the bot-PR batch).
     */
    async reviewQueue({ login, search = 'review-requested:@me is:open is:pr', first = 50 } = {}) {
      const out = await run(
        [
          'api',
          'graphql',
          '-F', `q=${search}`,
          '-F', `me=${login}`,
          '-F', `first=${first}`,
          '-f', `query=${QUEUE_QUERY}`,
        ],
        { bin, timeoutMs }
      );
      return parseQueue(out, login);
    },

    /**
     * States for an explicit list of `{repo, number}` — one call for all of them.
     * Returns `repo#number -> 'OPEN'|'MERGED'|'CLOSED'`, omitting any that could
     * not be resolved.
     */
    async prStates(refs) {
      if (!refs || !refs.length) return {};
      const out = await run(
        ['api', 'graphql', '-f', `query=${buildStatesQuery(refs)}`],
        { bin, timeoutMs, allowPartial: true }
      );
      return parseStates(out, refs);
    },
  };
}

module.exports = {
  createClient, parseQueue, normalizeNode, myReviewRequestedAt, QUEUE_QUERY, runGh,
  buildStatesQuery, parseStates,
};

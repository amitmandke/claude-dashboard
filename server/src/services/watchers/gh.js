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
      }
    }
  }
}`;

/** Run `gh` and resolve its stdout, rejecting with a useful message on failure. */
function runGh(args, { bin = DEFAULT_BIN, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
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
 * Flatten one GraphQL node into the flat shape `reviews.js` expects. A review
 * with a null `submittedAt` is PENDING (started, never submitted) and must read
 * as "not reviewed", which falling through to null achieves.
 */
function normalizeNode(n) {
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
  };
}

/** Exported for tests: parse a raw `gh api graphql` response into PRs. */
function parseQueue(stdout) {
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
    prs: (search.nodes || []).map(normalizeNode).filter(Boolean),
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
      return parseQueue(out);
    },
  };
}

module.exports = { createClient, parseQueue, normalizeNode, QUEUE_QUERY, runGh };

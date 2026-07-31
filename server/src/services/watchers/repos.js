'use strict';

/**
 * Local repo discovery — maps a GitHub `owner/repo` (as it appears in a PR URL)
 * to a working copy on disk, so a Slack thread that references a PR can resolve
 * to the right `cwd` for a candidate. Built by scanning a base directory for git
 * checkouts and reading each one's `origin` remote; no hand-maintained map, and
 * it re-scans on a TTL so newly-cloned repos appear.
 *
 * When the same `owner/repo` is checked out more than once (e.g. a primary tree
 * and a scratch/debug tree), the checkout whose parent folder matches
 * `preferDir` wins; otherwise first-found wins.
 */

const fs = require('fs');
const path = require('path');

/** `git@github.com:owner/repo.git` or `https://github.com/owner/repo(.git)` → `owner/repo`. */
function parseRemoteUrl(url) {
  if (!url) return null;
  const s = url.trim().replace(/\.git$/, '');
  let m = s.match(/^git@[^:]+:(.+)$/); // scp-style ssh
  if (m) return m[1].toLowerCase();
  m = s.match(/^ssh:\/\/[^/]+\/(.+)$/);
  if (m) return m[1].toLowerCase();
  m = s.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (m) return m[1].toLowerCase();
  return null;
}

/** Read the `origin` url out of a checkout's `.git/config`; null if absent. */
function originUrl(repoDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(repoDir, '.git', 'config'), 'utf8');
  } catch {
    return null;
  }
  // find the [remote "origin"] section, then the first url= within it
  const idx = text.search(/\[remote "origin"\]/);
  if (idx === -1) return null;
  const rest = text.slice(idx);
  const end = rest.search(/\n\[/); // next section header
  const section = end === -1 ? rest : rest.slice(0, end);
  const m = section.match(/^\s*url\s*=\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Directories that contain a `.git` folder, searched to `depth` levels under base. */
function findCheckouts(base, depth, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.isDirectory() && e.name === '.git')) out.push(base);
  if (depth > 0) {
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && !e.name.startsWith('.')) {
        findCheckouts(path.join(base, e.name), depth - 1, out);
      }
    }
  }
  return out;
}

/**
 * Every checkout under `base` with its `owner/repo` and parent-folder name —
 * including DUPLICATES of the same repo, which `buildMap` collapses. The
 * duplicates are the point for a UI: they are what `preferDir` chooses between.
 * One filesystem walk; `buildMap` derives from this.
 */
function listCheckouts(base, { depth = 2 } = {}) {
  const out = [];
  for (const dir of findCheckouts(base, depth)) {
    const key = parseRemoteUrl(originUrl(dir));
    if (key) out.push({ key, dir, parent: path.basename(path.dirname(dir)) });
  }
  return out;
}

/** `owner/repo` → local path, preferring a checkout whose parent is `preferDir`. */
function mapFromCheckouts(checkouts, preferDir = null) {
  const map = new Map();
  for (const { key, dir, parent } of checkouts) {
    if (!map.has(key)) map.set(key, dir);
    else if (preferDir && parent === preferDir) map.set(key, dir); // preferred overrides first-found
  }
  return map;
}

/**
 * Build `owner/repo` → local path from all checkouts under `base`. `preferDir`
 * is the parent-folder name that wins ties (e.g. 'acme'). Pure over the
 * filesystem: pass a small `base` in tests.
 */
function buildMap(base, { depth = 2, preferDir = null } = {}) {
  return mapFromCheckouts(listCheckouts(base, { depth }), preferDir);
}

function create({ base, depth = 2, preferDir = null, ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  let map = null;
  let checkouts = null;
  let builtAt = 0;

  function ensure() {
    if (!map || now() - builtAt > ttlMs) {
      checkouts = listCheckouts(base, { depth });
      map = mapFromCheckouts(checkouts, preferDir);
      builtAt = now();
    }
    return map;
  }

  return {
    /** `owner/repo` (case-insensitive) → local path, or null if not checked out. */
    resolve(ownerRepo) {
      if (!ownerRepo) return null;
      return ensure().get(String(ownerRepo).toLowerCase()) || null;
    },
    /** Known `owner/repo` keys — handy for logging/status. */
    list() {
      return [...ensure().keys()].sort();
    },
    /**
     * Every discovered checkout path — for the editor's folder picker. Derived
     * from the pre-collapse list, so BOTH copies of a twice-cloned repo appear
     * (the map keeps only one).
     */
    dirs() {
      ensure();
      return [...new Set(checkouts.map((c) => c.dir))].sort();
    },
    _rebuild() {
      map = null;
      return ensure();
    },
  };
}

module.exports = { create, buildMap, listCheckouts, mapFromCheckouts, parseRemoteUrl, originUrl, findCheckouts };

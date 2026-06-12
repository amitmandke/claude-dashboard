'use strict';

/**
 * User-assigned session titles — override the auto-derived ones. Persisted to
 * ~/.claude-dashboard/titles.json (our own dir; never write into ~/.claude),
 * keyed by sessionId so a title survives server restarts.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');

const DATA_DIR = config.DATA_DIR;
const FILE = path.join(DATA_DIR, 'titles.json');
const MAX_ENTRIES = 200;

let titles = null;

function load() {
  if (titles) return titles;
  try {
    titles = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    titles = {};
  }
  return titles;
}

function save() {
  const keys = Object.keys(titles);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete titles[k];
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(titles, null, 2));
}

function get(sessionId) {
  return load()[sessionId] || null;
}

/** Empty/blank title clears the override, reverting to the auto title. */
function set(sessionId, title) {
  load();
  const t = (title || '').trim();
  if (t) titles[sessionId] = t.slice(0, 120);
  else delete titles[sessionId];
  save();
}

module.exports = { get, set };

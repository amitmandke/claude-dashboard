'use strict';

/**
 * Recent projects — distinct project directories from ~/.claude/history.jsonl,
 * newest first. Powers the "New Session" directory picker.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { readTail, parseLines } = require('../utils/fsio');

const HISTORY_FILE = path.join(config.CLAUDE_DIR, 'history.jsonl');
const HISTORY_TAIL_BYTES = 512 * 1024;
const MAX_PROJECTS = 25;

function recentProjects() {
  const entries = parseLines(readTail(HISTORY_FILE, HISTORY_TAIL_BYTES));
  const seen = new Set();
  const projects = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const p = entries[i].project;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (!fs.existsSync(p)) continue; // dropped/renamed dirs
    projects.push(p);
    if (projects.length >= MAX_PROJECTS) break;
  }
  return projects;
}

module.exports = { recentProjects };

'use strict';

const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
// dashboard's own data dir; override (e.g. in tests) with CLAUDE_DASH_DATA_DIR
const DATA_DIR = process.env.CLAUDE_DASH_DATA_DIR || path.join(os.homedir(), '.claude-dashboard');

module.exports = {
  PORT: parseInt(process.env.PORT || '7777', 10),
  HOST: process.env.HOST || '127.0.0.1',

  // Claude Code data sources
  CLAUDE_DIR,
  SESSIONS_DIR: path.join(CLAUDE_DIR, 'sessions'),
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),

  // frontend app served by this process
  WEB_ROOT: path.resolve(__dirname, '../../web/public'),

  // transcript parsing limits
  TAIL_BYTES: 512 * 1024, // transcript tail parsed for the event feed
  HEAD_BYTES: 256 * 1024, // transcript head scanned for the first prompt
  MAX_EVENTS: 40,         // events per session sent to the UI
  FULL_TEXT_BYTES: 64 * 1024, // cap for the on-demand full-message endpoint

  SSE_INTERVAL_MS: 1500,  // how often the SSE loop polls for changes

  // dashboard's own data dir (custom titles, AI title cache) — never write into ~/.claude
  DATA_DIR,

  // AI-derived session titles via headless `claude -p` (uses the user's Claude
  // subscription; no API key). Disable with CLAUDE_DASH_AI_TITLES=0.
  AI_TITLES: process.env.CLAUDE_DASH_AI_TITLES !== '0',
  AI_TITLE_MODEL: process.env.CLAUDE_DASH_AI_TITLE_MODEL || 'haiku',
  CLAUDE_BIN: process.env.CLAUDE_DASH_CLAUDE_BIN || 'claude',
  // headless runs execute here so the registry can recognize and hide them
  HEADLESS_CWD: path.join(DATA_DIR, 'headless'),

  // Candidate sessions — a launchable, prioritized pending list a producer (a
  // running session, a watcher, or the user) adds to; persisted in
  // ~/.claude-dashboard/candidates.json. Caps keep the list and concurrency sane.
  CANDIDATES_MAX_PENDING: parseInt(process.env.CLAUDE_DASH_MAX_PENDING || '100', 10),
  CANDIDATES_MAX_CONCURRENT: parseInt(process.env.CLAUDE_DASH_MAX_CONCURRENT || '6', 10),
  // dismissed items linger as history for a while; launched ones clear sooner
  // since they've already become a live session (you can also ✕ Clear either now).
  CANDIDATES_RETENTION_DAYS: parseInt(process.env.CLAUDE_DASH_RETENTION_DAYS || '7', 10),
  CANDIDATES_LAUNCHED_RETENTION_HOURS: parseInt(process.env.CLAUDE_DASH_LAUNCHED_RETENTION_HOURS || '2', 10),
};

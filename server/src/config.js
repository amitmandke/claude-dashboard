'use strict';

const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

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

  SSE_INTERVAL_MS: 1500,  // how often the SSE loop polls for changes
};

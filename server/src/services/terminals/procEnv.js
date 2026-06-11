'use strict';

/**
 * Per-process environment probe — how a claude pid is matched to the terminal
 * that hosts it. `ps -E` exposes the process environment; the variables we need
 * (TERM_PROGRAM, TMUX, ITERM_SESSION_ID) never contain spaces. Cached per pid:
 * a process's environment cannot change after launch.
 */

const { execFile } = require('child_process');

const cache = new Map(); // pid -> {termProgram, tmux, itermId, tty}

function get(pid) {
  if (cache.has(pid)) return Promise.resolve(cache.get(pid));
  return new Promise((resolve) => {
    execFile('ps', ['-E', '-p', String(pid), '-o', 'tty=,command='], (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null); // process gone — don't cache
      const tty = stdout.trim().split(/\s+/)[0];
      const info = {
        tty: tty && tty !== '??' ? '/dev/' + tty : null,
        termProgram: (stdout.match(/TERM_PROGRAM=(\S+)/) || [])[1] || null,
        tmux: /\bTMUX=\S/.test(stdout),
        itermId: (stdout.match(/ITERM_SESSION_ID=\S*?([0-9A-F-]{36})/i) || [])[1] || null,
      };
      cache.set(pid, info);
      resolve(info);
    });
  });
}

module.exports = { get };

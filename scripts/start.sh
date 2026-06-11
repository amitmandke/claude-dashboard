#!/usr/bin/env bash
# Start the Claude Dashboard and open it in the default browser.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-7777}"

if lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Dashboard already running on port ${PORT}"
else
  nohup node server/src/index.js >/tmp/claude-dashboard.log 2>&1 &
  echo "Started dashboard (pid $!) — logs: /tmp/claude-dashboard.log"
  sleep 0.5
fi

open "http://localhost:${PORT}"

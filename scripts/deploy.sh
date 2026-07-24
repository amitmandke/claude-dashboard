#!/usr/bin/env bash
# Deploy the dashboard. Run this from the DEPLOYED checkout (e.g. ~/.claude-dashboard/app),
# NOT your dev working tree — it fast-forwards that copy to origin/main and restarts the
# launchd agent, so only merged `main` ever runs live. Dev edits in a separate working
# tree (on any port) never touch the running dashboard until you deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
LABEL=com.claude-dashboard

git fetch --quiet origin
git reset --hard --quiet origin/main
echo "deployed $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

if launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null; then
  echo "restarted $LABEL"
else
  echo "agent not running yet — run ./scripts/install-launchd.sh from here once to install it"
fi

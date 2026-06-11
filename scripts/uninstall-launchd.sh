#!/usr/bin/env bash
# Remove the launchd user agent installed by install-launchd.sh.
set -euo pipefail

LABEL=com.claude-dashboard
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL (the dashboard server has been stopped)"

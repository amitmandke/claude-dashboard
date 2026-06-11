#!/usr/bin/env bash
# Install the dashboard as a macOS launchd user agent: starts at login,
# restarts on crash. Re-run after moving the repo or upgrading Node.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL=com.claude-dashboard
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
PORT="${PORT:-7777}"
LOG="$HOME/Library/Logs/claude-dashboard.log"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# stop any ad-hoc instance occupying the port, and any previous install
lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$(pwd)/server/src/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL — starts at login, restarts on crash"
echo "  dashboard: http://localhost:$PORT"
echo "  logs:      $LOG"
echo "  uninstall: ./scripts/uninstall-launchd.sh"

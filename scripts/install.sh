#!/bin/zsh
# Install the two launchd agents:
#   * com.dvaladares.evcanada.update  — refreshes data daily at 09:00 (+ at load)
#   * com.dvaladares.evcanada.server  — keeps the local web server alive
# Idempotent: re-running re-generates the plists and reloads the agents.
set -e

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
PY="${EVDASH_PYTHON:-/opt/homebrew/bin/python3}"
[ -x "$PY" ] || PY="$(command -v python3)"
PORT="${EVDASH_PORT:-8787}"
UID_NUM="$(id -u)"
LA="$HOME/Library/LaunchAgents"
DOMAIN="gui/$UID_NUM"
mkdir -p "$LA" "$PROJ/logs"

UPDATE_LABEL="com.dvaladares.evcanada.update"
SERVER_LABEL="com.dvaladares.evcanada.server"
UPDATE_PLIST="$LA/$UPDATE_LABEL.plist"
SERVER_PLIST="$LA/$SERVER_LABEL.plist"

echo "Project : $PROJ"
echo "Python  : $PY"
echo "Port    : $PORT"
echo "Agents  : $LA"
echo

cat > "$UPDATE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$UPDATE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$PROJ/scripts/run_update.sh</string>
    <string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EVDASH_PYTHON</key><string>$PY</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$PROJ/logs/launchd_update.log</string>
  <key>StandardErrorPath</key><string>$PROJ/logs/launchd_update.log</string>
  <key>WorkingDirectory</key><string>$PROJ</string>
</dict>
</plist>
EOF

cat > "$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$PROJ/scripts/serve.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EVDASH_PYTHON</key><string>$PY</string>
    <key>EVDASH_PORT</key><string>$PORT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJ/logs/launchd_server.log</string>
  <key>StandardErrorPath</key><string>$PROJ/logs/launchd_server.log</string>
  <key>WorkingDirectory</key><string>$PROJ</string>
</dict>
</plist>
EOF

echo "Wrote:"
echo "  $UPDATE_PLIST"
echo "  $SERVER_PLIST"
echo

# Reload (bootout if already loaded; ignore errors), then bootstrap.
for L in "$UPDATE_LABEL" "$SERVER_LABEL"; do
  launchctl bootout "$DOMAIN/$L" 2>/dev/null || true
done
launchctl bootstrap "$DOMAIN" "$UPDATE_PLIST"
launchctl bootstrap "$DOMAIN" "$SERVER_PLIST"
# Kick an immediate data refresh.
launchctl kickstart -k "$DOMAIN/$UPDATE_LABEL" 2>/dev/null || true

echo "Loaded agents:"
launchctl list | grep evcanada || true
echo
echo "Dashboard will be live at: http://127.0.0.1:$PORT/"
echo "Update runs at login and daily at 09:00. Logs in $PROJ/logs/."

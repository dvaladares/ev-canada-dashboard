#!/bin/zsh
# Stop and remove the launchd agents. Leaves project files intact.
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
LA="$HOME/Library/LaunchAgents"
for L in com.dvaladares.evcanada.update com.dvaladares.evcanada.server; do
  launchctl bootout "$DOMAIN/$L" 2>/dev/null && echo "Unloaded $L" || echo "$L not loaded"
  rm -f "$LA/$L.plist" && echo "Removed $LA/$L.plist"
done
echo "Done. Project files were not touched."

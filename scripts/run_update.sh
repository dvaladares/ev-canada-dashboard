#!/bin/zsh
# Refresh the dashboard data. Safe to run manually or from launchd.
# Usage: scripts/run_update.sh [--force-izev] [--quiet]
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ"
PY="${EVDASH_PYTHON:-/opt/homebrew/bin/python3}"
[ -x "$PY" ] || PY="$(command -v python3)"
exec "$PY" "$PROJ/fetch_data.py" "$@"

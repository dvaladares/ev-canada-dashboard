#!/bin/zsh
# Serve the dashboard locally. The page lives at http://127.0.0.1:$PORT/
# Bound to loopback only (not exposed to the network).
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${EVDASH_PORT:-8787}"
PY="${EVDASH_PYTHON:-/opt/homebrew/bin/python3}"
[ -x "$PY" ] || PY="$(command -v python3)"
cd "$PROJ/site"
exec "$PY" -m http.server "$PORT" --bind 127.0.0.1

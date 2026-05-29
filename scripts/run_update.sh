#!/bin/zsh
# Refresh the dashboard data. Safe to run manually or from launchd.
# Usage: scripts/run_update.sh [--force-izev] [--quiet]
#
# Optional auto-publish (for the hosted public copy):
#   set EVDASH_DEPLOY=1 to, after a successful refresh, commit any changed
#   tracked files (site/data/ev_sales.json, site/index.html) and push to
#   origin main. The Vercel project is git-connected to that branch, so the
#   push itself triggers the production deploy (no `vercel` CLI call needed).
#   When EVDASH_DEPLOY is unset/0, behaviour is unchanged (local refresh only).
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ"
PY="${EVDASH_PYTHON:-/opt/homebrew/bin/python3}"
[ -x "$PY" ] || PY="$(command -v python3)"

# 1) Refresh data (do NOT exec — we may have deploy work after).
"$PY" "$PROJ/fetch_data.py" "$@"

# 2) Optional: publish to the hosted Vercel copy.
if [ "${EVDASH_DEPLOY:-0}" != "1" ]; then
  exit 0
fi

GIT="$(command -v git || echo /usr/bin/git)"

# Only the tracked outputs matter; root data/ is gitignored.
# Use an array so the paths expand as separate arguments under zsh.
TRACKED=(site/data/ev_sales.json site/index.html)

# fetch_data.py rewrites "generated_at" every run, so a raw `git diff` is always
# dirty even when the numbers are unchanged. Compare the SUBSTANTIVE data instead
# (committed vs working, ignoring the volatile generated_at/subtitle fields). Only
# deploy when the actual figures move -- StatCan is quarterly, so most runs are no-ops.
DATA_CHANGED="$("$PY" - "$PROJ" <<'PYEOF'
import json, subprocess, sys, hashlib
proj = sys.argv[1]
path = "site/data/ev_sales.json"
def norm(d):
    d.pop("generated_at", None); d.pop("subtitle", None)
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()
try:
    committed = json.loads(subprocess.check_output(["git", "show", f"HEAD:{path}"], cwd=proj))
except Exception:
    print("1"); sys.exit(0)            # no committed version -> treat as changed
working = json.load(open(f"{proj}/{path}"))
print("1" if norm(committed) != norm(working) else "0")
PYEOF
)"

if [ "$DATA_CHANGED" != "1" ]; then
  echo "publish: no substantive data change (only timestamp); reverting churn, skipping push."
  "$GIT" checkout -- "${TRACKED[@]}" 2>/dev/null || true
  exit 0
fi

echo "publish: data changed; committing + pushing (Vercel auto-deploys on push)."
"$GIT" add "${TRACKED[@]}"
STAMP="$(date '+%Y-%m-%d %H:%M')"
# Author pinned to personal identity (never the 7gen address).
"$GIT" -c user.email="dvaladares@gmail.com" -c user.name="Daniel Valadares" \
  commit -m "Data refresh: $STAMP" \
  -m "Automated by scripts/run_update.sh (launchd). Source: Statistics Canada + iZEV." \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

# Vercel is git-connected to origin/main -> this push triggers the production deploy.
"$GIT" push origin main
echo "publish: pushed; Vercel will deploy automatically."

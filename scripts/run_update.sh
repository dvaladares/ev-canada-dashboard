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
#   The hosted copy normally refreshes itself via .github/workflows/refresh.yml;
#   this local deploy path is a manual fallback.
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJ"
PY="${EVDASH_PYTHON:-/opt/homebrew/bin/python3}"
[ -x "$PY" ] || PY="$(command -v python3)"

# 1) Refresh data (do NOT exec: we may have deploy work after).
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
if "$PY" "$PROJ/scripts/data_changed.py"; then DATA_CHANGED=1; else DATA_CHANGED=0; fi

if [ "$DATA_CHANGED" != "1" ]; then
  echo "publish: no substantive data change (only timestamp); reverting churn, skipping push."
  "$GIT" checkout -- "${TRACKED[@]}" 2>/dev/null || true
  exit 0
fi

echo "publish: data changed; committing + pushing (Vercel auto-deploys on push)."
"$GIT" add "${TRACKED[@]}"
STAMP="$(date '+%Y-%m-%d %H:%M')"
"$GIT" -c user.email="dvaladares@gmail.com" -c user.name="Daniel Valadares" \
  commit -m "Data refresh: $STAMP" \
  -m "Automated by scripts/run_update.sh (launchd). Source: Statistics Canada + iZEV." \

# Vercel is git-connected to origin/main -> this push triggers the production deploy.
"$GIT" push origin main
echo "publish: pushed; Vercel will deploy automatically."

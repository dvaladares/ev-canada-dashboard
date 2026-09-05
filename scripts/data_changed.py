#!/usr/bin/env python3
"""Exit 0 if site/data/ev_sales.json changed substantively vs HEAD, else exit 1.

fetch_data.py rewrites generated_at on every run, so a plain git diff is always
dirty. This compares the data with the volatile fields removed. Used by the
GitHub Actions refresh workflow and by scripts/run_update.sh.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

PROJ = Path(__file__).resolve().parent.parent
PATH = "site/data/ev_sales.json"
VOLATILE = ("generated_at", "subtitle", "sources", "build")


def norm(d):
    for k in VOLATILE:
        d.pop(k, None)
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()


def main():
    try:
        committed = json.loads(subprocess.check_output(["git", "show", f"HEAD:{PATH}"], cwd=PROJ))
    except (subprocess.CalledProcessError, ValueError):
        return 0
    working = json.loads((PROJ / PATH).read_text())
    return 0 if norm(committed) != norm(working) else 1


if __name__ == "__main__":
    sys.exit(main())

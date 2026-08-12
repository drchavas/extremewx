#!/usr/bin/env bash
# Refresh IBTrACS data and rebuild storms.js in this folder.
# Called by ../../../deploy.sh before the upload step so the fresh storms.js gets deployed.
# To avoid re-downloading the ~57 MB CSV on back-to-back deploys, it only re-downloads
# when the local copy is missing or older than MAXAGE_HOURS; otherwise it just rebuilds.
set -euo pipefail
cd "$(dirname "$0")"

CSV="ibtracs.ALL.list.v04r01.csv"
MAXAGE_HOURS=12

need_dl=1
if [ -f "$CSV" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$CSV") ))     # macOS/BSD stat
  [ "$age" -lt $(( MAXAGE_HOURS * 3600 )) ] && need_dl=0
fi

if [ "$need_dl" -eq 1 ]; then
  echo "  → downloading latest IBTrACS CSV + rebuilding storms.js"
  python3 process_storms.py --update
else
  echo "  → IBTrACS CSV is <${MAXAGE_HOURS}h old; rebuilding storms.js from it"
  python3 process_storms.py
fi

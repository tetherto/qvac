#!/usr/bin/env bash
# Fetch the `matrix-combine` report markdown from one or more VLM-benchmark runs, so it
# can be fed to aggregate-checkpoint.cjs. Writes report-1.md, report-2.md, ... into the
# current directory.
#
# Usage:  ./collect-reports.sh <run-id> [<run-id> ...]
#   e.g.  ./collect-reports.sh 28456710122 28460253523 28464127256
#
# Requires: `gh` authenticated with access to tetherto/qvac. Run IDs are printed by
# `gh workflow run ... ` (or the Actions UI URL). See README.md for the full procedure.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <run-id> [<run-id> ...]" >&2
  exit 1
fi

i=1
for run in "$@"; do
  jid="$(gh run view "$run" --repo tetherto/qvac --json jobs \
        --jq '.jobs[] | select(.name | test("combine";"i")) | .databaseId' | head -1)"
  if [ -z "$jid" ]; then
    echo "run $run: no matrix-combine job found (did the run finish?)" >&2
    exit 1
  fi
  # The job log prefixes every line with "<group>\t<step>\t<ISO-timestamp>Z <content>".
  # Keep everything after the timestamp's trailing "Z " to recover the report markdown.
  gh run view --repo tetherto/qvac --job "$jid" --log \
    | grep -aoE 'Z[[:space:]].*' \
    | sed -E 's/^Z[[:space:]]+//' > "report-$i.md"
  echo "run $run (combine job $jid) -> report-$i.md ($(grep -c . "report-$i.md") lines)"
  i=$((i + 1))
done

echo
echo "Next: node ../aggregate-checkpoint.cjs report-*.md   (add --date YYYY-MM-DD to pin the date)"

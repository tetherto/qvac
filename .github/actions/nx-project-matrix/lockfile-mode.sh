#!/usr/bin/env bash
# Decides how a lockfile change counts toward nx affected for one run.
#
# nx.json sets projectsAffectedByDependencyUpdates to [], so the lockfile marks
# nothing and a package is selected through its own files. pnpm rewrites shared
# entries for many importers on a one-line dependency change, so any mode that
# reasons from the lockfile selects most of the workspace.
#
# That leaves one case with no owner: pnpm-lock.yaml changed and no package.json
# did, as with a transitive security bump. Selecting nothing there would merge it
# untested, so for that run the lockfile is analysed instead ("auto"), which
# marks only the importers whose resolution changed.
#
# Reads changed paths on stdin, one per line. Prints "auto" for a lockfile-only
# change, and nothing otherwise.
set -euo pipefail

paths=$(cat)

if printf '%s\n' "$paths" | grep -qx 'pnpm-lock.yaml' \
  && ! printf '%s\n' "$paths" | grep -qE '(^|/)package\.json$'; then
  echo auto
fi

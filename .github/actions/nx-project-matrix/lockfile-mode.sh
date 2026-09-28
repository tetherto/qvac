#!/usr/bin/env bash
# Decides how a lockfile change counts toward nx affected for one run.
#
# nx.json sets projectsAffectedByDependencyUpdates to [], so the lockfile marks
# nothing and a package is selected through its own files, including the
# package.json a dependency bump edits. pnpm rewrites shared entries for many
# importers on a one-line dependency change, so any mode that reasons from the
# lockfile selects most of the workspace.
#
# If pnpm-lock.yaml changed and no workspace manifest did, nothing explains the
# change, so keep today's behaviour ("all") rather than select nothing. Not
# "auto": on the --stdin lane nx cannot diff the lockfile and "auto" already
# selects everything, while on --base/--head it narrows, so the two lanes would
# disagree about the same PR.
#
# Only workspace manifests count, per pnpm-workspace.yaml. docs/website,
# benchmark servers and test fixtures carry package.json files that own nothing
# in this lockfile.
#
# Reads changed paths on stdin, one per line. Prints "all" when the fallback
# applies, and nothing otherwise.
set -euo pipefail

paths=$(cat)

# Here-strings, not `printf | grep -q`: grep -q exits on the first match, and
# under pipefail the writer's SIGPIPE turns a match into a failure once the list
# outgrows the pipe buffer.
manifest='^(package\.json|packages/[^/]+/package\.json|packages/registry-server/(client|shared)/package\.json|plugins/[^/]+/package\.json)$'

if grep -qx 'pnpm-lock.yaml' <<<"$paths" && ! grep -qE "$manifest" <<<"$paths"; then
  echo all
fi

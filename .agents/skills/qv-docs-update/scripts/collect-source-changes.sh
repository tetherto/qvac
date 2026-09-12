#!/usr/bin/env bash
#
# Phase 1 of qv-docs-update — deterministic collection, zero questions asked.
#
# Emits a JSON SOURCE_CHANGE_SET skeleton on stdout: the merge base, every
# changed path under the three observed packages, and each path's bucket. The
# bucket is what decides which router runs in Phase 4, so it is computed here
# rather than left to the model.
#
# Usage:
#   collect-source-changes.sh [--base <ref>] [--repo <path>]
#
#   --base   base ref to diff against. Default: `main` on the remote whose URL
#            points at tetherto/qvac, whatever that remote is called locally,
#            falling back to the sole remote when only one exists. The merge
#            base with HEAD is used, never the ref's tip, so an out-of-date
#            branch does not report the base's own commits as local changes.
#   --repo   monorepo root. Default: the repo containing this script.
#
# The developer invokes the skill mid-work, so committed changes alone are not
# enough. All four states are collected and unioned: committed on the branch,
# staged, unstaged, and untracked.
#
# Exit codes:
#   0  collection succeeded (including the no-change case — read `state`)
#   2  usage error, or not a git repo, or no usable base ref

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

BASE_REF=""
REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE_REF="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "collect-source-changes: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
fi

if [[ -z "$REPO" ]] || ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null; then
  echo "collect-source-changes: not a git repository: ${REPO:-<unset>}" >&2
  exit 2
fi

# The three observed source packages. Anything outside them is not collected at
# all — the skill's whole premise is that docs drift is driven by these three.
SOURCE_PATHS=(
  "packages/sdk"
  "packages/sdk-python"
  "packages/cli"
)

# ---------------------------------------------------------------------------
# Resolve the base
# ---------------------------------------------------------------------------

# Sets BASE_REF to a resolvable ref and BASE_VIA to how it was chosen. Both
# reach the JSON, so a wrong base shows up in the report instead of silently
# shaping every later phase.
resolve_base() {
  if [[ -n "$BASE_REF" ]]; then
    if git -C "$REPO" rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
      BASE_VIA="explicit"
      return 0
    fi
    echo "collect-source-changes: base ref not found: $BASE_REF" >&2
    return 1
  fi

  # The base is the upstream monorepo, identified by URL and never by name. The
  # remote is `origin` in the default setup (a branch on tetherto/qvac, which is
  # how the repo is used), `tether` in some clones, and `upstream` in a fork
  # setup. Choosing by name tried `origin/main` first and, on a clone whose
  # origin was a fork 1384 commits behind, collected 1565 files as "changes".
  local remote url
  while read -r remote; do
    url="$(git -C "$REPO" remote get-url "$remote" 2>/dev/null || true)"
    case "$url" in
      *tetherto/qvac|*tetherto/qvac.git)
        if git -C "$REPO" rev-parse --verify --quiet "$remote/main" >/dev/null; then
          BASE_REF="$remote/main"
          BASE_VIA="url"
          return 0
        fi
        ;;
    esac
  done < <(git -C "$REPO" remote)

  # One remote and no URL match: an internal mirror, or a host renamed. With a
  # single remote there is no fork to confuse it with.
  local remote_count
  remote_count="$(git -C "$REPO" remote | wc -l)"
  if [[ "$remote_count" -eq 1 ]]; then
    remote="$(git -C "$REPO" remote)"
    if git -C "$REPO" rev-parse --verify --quiet "$remote/main" >/dev/null; then
      BASE_REF="$remote/main"
      BASE_VIA="single-remote"
      return 0
    fi
  fi

  echo "collect-source-changes: cannot tell which remote is the monorepo — pass --base <ref>" >&2
  return 1
}

BASE_VIA=""
resolve_base || exit 2
BASE_SHA="$(git -C "$REPO" merge-base HEAD "$BASE_REF")"
BASE_SHORT="$(git -C "$REPO" rev-parse --short "$BASE_SHA")"

# ---------------------------------------------------------------------------
# Collect the four states
# ---------------------------------------------------------------------------

collect_paths() {
  {
    # `git diff <base>` (no `..HEAD`, no `--cached`) compares the base against
    # the WORKING TREE, so one invocation covers three of the four states at
    # once: committed on the branch, staged, and unstaged. Running the three
    # diffs separately would also require reconciling their statuses, since a
    # path can be added in a commit and then modified unstaged.
    git -C "$REPO" diff --name-status "$BASE_SHA" -- "${SOURCE_PATHS[@]}"

    # The fourth state. An untracked file is invisible to every diff above, and
    # a brand-new untracked example is the most common shape of "I added an
    # example" — the single strongest documentary signal the skill has.
    git -C "$REPO" ls-files --others --exclude-standard -- "${SOURCE_PATHS[@]}" \
      | sed 's/^/A\t/'
  } | sed '/^$/d' | LC_ALL=C sort -u -k2
}

# ---------------------------------------------------------------------------
# Bucket classification
#
# Order matters: the first matching pattern wins, so the narrow patterns are
# listed before the broad ones (api/ before client-other, barrels before api/).
# ---------------------------------------------------------------------------

bucket_for() {
  local p="$1"

  case "$p" in
    # Barrels and shared type/schema surface. Listed first because
    # src/client/api/index.ts is a barrel, not an api file.
    packages/sdk/src/index.ts|packages/sdk/src/client/api/index.ts|packages/sdk/src/client/index.ts) echo "surface"; return ;;
    packages/sdk/src/types/*|packages/sdk/src/schemas/*) echo "surface"; return ;;

    # Examples — the strongest documentary signal, since pages reference them
    # by literal path.
    packages/sdk/examples/*|packages/sdk-python/examples/*) echo "examples"; return ;;

    # One file per public function.
    packages/sdk/src/client/api/*) echo "api"; return ;;
    packages/sdk/src/client/*) echo "client-other"; return ;;

    # Areas with a declared page mapping in routing-map.yaml.
    packages/sdk/src/logging/*|packages/sdk/src/models/*|packages/sdk/src/server/*|packages/sdk/src/worker/*) echo "area"; return ;;

    # CLI: infra before commands, because src/cli/ is the command framework
    # and would otherwise match the command glob.
    packages/cli/src/cli/*) echo "cli-infra"; return ;;
    packages/cli/src/config.ts|packages/cli/src/errors.ts|packages/cli/src/logger.ts|packages/cli/src/index.ts) echo "cli-infra"; return ;;
    # Any command folder, not a closed list of the commands that exist today. A
    # NEW command has to reach R4, which routes it to the `## Reference` section
    # of cli/index.mdx. A closed list bucketed it `internal`, and a run that is
    # internal-only stops at NO_DOCS_IMPACT — an entire new command disappearing
    # without a word (acceptance scenario Q).
    packages/cli/src/*/*) echo "cli-command"; return ;;

    packages/sdk-python/*) echo "python-surface"; return ;;
  esac

  echo "internal"
}

# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------

# Buckets that carry strong evidence of documentary impact, and their inverse.
# Phase 1 records the weight it assigned so the report can show its reasoning
# instead of asserting a verdict.
is_strong_evidence() {
  case "$1" in
    examples|api|cli-command) return 0 ;;
    *) return 1 ;;
  esac
}

json_escape() {
  # Escape the subset that can appear in a git path: backslash and quote.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Parallel arrays: CHANGED_PATHS[i] has status CHANGED_STATUS[i].
# A rename arrives as `R100\told\tnew`; the new path is what documentation can
# reference, so it is the one recorded.
CHANGED_PATHS=()
CHANGED_STATUS=()
while IFS=$'\t' read -r status first second; do
  [[ -z "$status" || -z "$first" ]] && continue
  if [[ "$status" == R* && -n "$second" ]]; then
    CHANGED_PATHS+=("$second")
    CHANGED_STATUS+=("R")
  else
    CHANGED_PATHS+=("$first")
    CHANGED_STATUS+=("${status:0:1}")
  fi
done < <(collect_paths)

# `state` is advisory: the skill owns the state machine. Phase 1 only reports
# the two terminals it can decide on its own.
#   - nothing changed at all                -> NO_SOURCE_CHANGE
#   - everything changed is internal-only   -> NO_DOCS_IMPACT
# Anything else is left as CONTINUE for Phase 3 to judge.
STATE="CONTINUE"
if [[ ${#CHANGED_PATHS[@]} -eq 0 ]]; then
  STATE="NO_SOURCE_CHANGE"
fi

BUCKET_SET=()
STRONG=0
FILES_JSON=""

for i in "${!CHANGED_PATHS[@]}"; do
  p="${CHANGED_PATHS[$i]}"
  st="${CHANGED_STATUS[$i]}"
  b="$(bucket_for "$p")"

  seen=0
  for existing in ${BUCKET_SET[@]+"${BUCKET_SET[@]}"}; do
    [[ "$existing" == "$b" ]] && seen=1 && break
  done
  [[ $seen -eq 0 ]] && BUCKET_SET+=("$b")

  is_strong_evidence "$b" && STRONG=1

  [[ -n "$FILES_JSON" ]] && FILES_JSON+=","
  FILES_JSON+=$'\n    {"path": "'"$(json_escape "$p")"'", "bucket": "'"$b"'", "status": "'"$st"'"}'
done

if [[ "$STATE" == "CONTINUE" && ${#BUCKET_SET[@]} -eq 1 && "${BUCKET_SET[0]:-}" == "internal" ]]; then
  STATE="NO_DOCS_IMPACT"
fi

BUCKETS_JSON=""
for b in ${BUCKET_SET[@]+"${BUCKET_SET[@]}"}; do
  [[ -n "$BUCKETS_JSON" ]] && BUCKETS_JSON+=", "
  BUCKETS_JSON+="\"$b\""
done

printf '{\n'
printf '  "state": "%s",\n' "$STATE"
printf '  "base": {"ref": "%s", "sha": "%s", "short": "%s", "via": "%s"},\n' \
  "$(json_escape "$BASE_REF")" "$BASE_SHA" "$BASE_SHORT" "$BASE_VIA"
printf '  "strong_evidence": %s,\n' "$([[ $STRONG -eq 1 ]] && echo true || echo false)"
printf '  "buckets": [%s],\n' "$BUCKETS_JSON"
printf '  "file_count": %d,\n' "${#CHANGED_PATHS[@]}"
printf '  "files": ['
if [[ -n "$FILES_JSON" ]]; then
  printf '%s\n  ' "$FILES_JSON"
fi
printf ']\n'
printf '}\n'

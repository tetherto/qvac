#!/usr/bin/env bash
# Helpers for fabric-nightly.yml. Needs GH_TOKEN and GITHUB_REPOSITORY.
#
#   fabric-nightly.sh dispatch <workflow-file> <ref> <sha> [-f key=value ...]   prints the run ID
#   fabric-nightly.sh wait <run-id> ...                                    blocks until all complete
#   fabric-nightly.sh report                                               writes the step summary
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?}"

# The dispatch API returns no run ID, so find the run by workflow, branch,
# event and the branch's head commit, which is unique per nightly attempt.
dispatch() {
  local workflow=$1 ref=$2 sha=$3
  shift 3
  gh workflow run "$workflow" --repo "$REPO" --ref "$ref" "$@" >&2
  local id=""
  for _ in $(seq 1 40); do
    id=$(gh api "repos/$REPO/actions/workflows/$workflow/runs?branch=$ref&event=workflow_dispatch&head_sha=$sha&per_page=1" \
      --jq '.workflow_runs[0].id // empty') || id=""
    [ -n "$id" ] && break
    sleep 15
  done
  if [ -z "$id" ]; then
    echo "::error::no $workflow run appeared on $ref after dispatch" >&2
    return 1
  fi
  echo "$id"
}

wait_runs() {
  local pending=("$@") next id status failed errors=0
  while [ "${#pending[@]}" -gt 0 ]; do
    next=()
    failed=""
    for id in "${pending[@]}"; do
      if ! status=$(gh api "repos/$REPO/actions/runs/$id" --jq '.status'); then
        failed="$failed $id"
        next+=("$id")
        continue
      fi
      [ "$status" = "completed" ] || next+=("$id")
    done
    # Fails after 10 rounds in a row with an unreadable run instead of polling to the job timeout.
    if [ -n "$failed" ]; then
      errors=$((errors + 1))
      if [ "$errors" -ge 10 ]; then
        echo "::error::run(s)$failed unreadable for $errors polls in a row" >&2
        return 1
      fi
    else
      errors=0
    fi
    pending=("${next[@]+"${next[@]}"}")
    [ "${#pending[@]}" -eq 0 ] || sleep 120
  done
}

# Reads FABRIC_REPO, FABRIC_BRANCH, FABRIC_SHA, FABRIC_TAG, RUN_ID and TEST_RESULT.
report() {
  local out=${GITHUB_STEP_SUMMARY:-/dev/stdout} failed=0 conclusion url jobs name total bad
  local cov_dir
  cov_dir=$(mktemp -d)

  {
    echo "## Fabric nightly"
    echo
    echo "- Branch: \`$FABRIC_BRANCH\` at [\`${FABRIC_SHA:0:9}\`](https://github.com/$FABRIC_REPO/commit/$FABRIC_SHA)"
    echo "- Latest tag: \`${FABRIC_TAG:-none}\`"
  } >>"$out"

  if [ -z "${RUN_ID:-}" ]; then
    printf '\nNo tests ran: pr-build-test was not dispatched. See the prepare job.\n' >>"$out"
    return 1
  fi
  if read -r conclusion url < <(gh api "repos/$REPO/actions/runs/$RUN_ID" --jq '"\(.conclusion // .status) \(.html_url)"'); then
    echo "- pr-build-test: **$conclusion** ([run $RUN_ID]($url))" >>"$out"
    [ "$conclusion" = "success" ] || failed=1
  else
    echo "- pr-build-test: _API error_ (run $RUN_ID)" >>"$out"
    failed=1
  fi
  if [ "${TEST_RESULT:-}" != "success" ]; then
    printf '\nThe wait ended with %s, so the run may still have been going. See the test job log.\n' "${TEST_RESULT:-unknown}" >>"$out"
    failed=1
  fi
  echo >>"$out"

  if [ -n "${FABRIC_TAG:-}" ]; then
    {
      echo "### Commits since ${FABRIC_TAG}"
      echo
      commits=$(gh api "repos/$FABRIC_REPO/compare/$FABRIC_TAG...$FABRIC_SHA" \
        --jq '"\(.ahead_by) commits ahead\(if .ahead_by > 30 then ", latest 30 shown" else "" end):\n",
          (.commits | reverse | .[:30][] | "- [`\(.sha[:9])`](\(.html_url)) \(.commit.message | split("\n")[0])")') \
        || commits="_Unavailable (API error)_"
      echo "$commits"
      echo
    } >>"$out"
  fi

  echo "### Jobs" >>"$out"
  echo >>"$out"
  if jobs=$(gh api --paginate "repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=30" \
    --jq '.jobs[]
      | select(.conclusion != "skipped")
      | select(.name | test("^(providers|build|cpp-lint|cpp-tests|desktop) / "))
      | select(.name | test(" / plan$") | not)
      | "\(.conclusion // .status)\t[\(.name)](\(.html_url))"'); then
    total=$(grep -c . <<<"$jobs" || true)
    bad=$(grep -v '^success'$'\t' <<<"$jobs" || true)
    echo "$(( total - $(grep -c . <<<"$bad" || true) )) of $total build and test jobs passed." >>"$out"
    if [ -n "$bad" ]; then
      printf '\n| Job | Result |\n|---|---|\n' >>"$out"
      awk -F'\t' '{print "| " $2 " | " $1 " |"}' <<<"$bad" >>"$out"
    fi
  else
    echo "_Job list unavailable (API error)._" >>"$out"
  fi

  {
    echo
    echo "### C++ line coverage"
    echo
    echo "| Report | Lines |"
    echo "|---|---|"
  } >>"$out"
  for name in $(gh api --paginate "repos/$REPO/actions/runs/$RUN_ID/artifacts?per_page=100" \
    --jq '.artifacts[] | select(.name | startswith("cpp-coverage-")) | .name'); do
    mkdir -p "$cov_dir/$name"
    gh run download "$RUN_ID" --repo "$REPO" --name "$name" --dir "$cov_dir/$name" >/dev/null 2>&1 || continue
    while IFS= read -r summary; do
      pct=$(awk '/^TOTAL/ {print $10}' "$summary")
      [ -n "$pct" ] && echo "| ${name#cpp-coverage-} | $pct |" >>"$out"
    done < <(find "$cov_dir/$name" -name coverage-summary.txt)
  done

  return "$failed"
}

case "${1:-}" in
  dispatch) shift; dispatch "$@" ;;
  wait) shift; wait_runs "$@" ;;
  report) report ;;
  *) echo "usage: $0 dispatch|wait|report" >&2; exit 2 ;;
esac

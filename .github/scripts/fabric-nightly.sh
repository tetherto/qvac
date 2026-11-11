#!/usr/bin/env bash
# Helpers for fabric-nightly.yml. Needs GH_TOKEN and GITHUB_REPOSITORY.
#
#   fabric-nightly.sh dispatch <workflow-file> <ref> [-f key=value ...]   prints the run ID
#   fabric-nightly.sh wait <run-id> ...                                    blocks until all complete
#   fabric-nightly.sh report                                               writes the step summary
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?}"

# The dispatch API returns no run ID, so find the run by workflow, branch and
# event. The nightly branch is unique per nightly, so the first match is ours.
dispatch() {
  local workflow=$1 ref=$2
  shift 2
  gh workflow run "$workflow" --repo "$REPO" --ref "$ref" "$@" >&2
  local id=""
  for _ in $(seq 1 40); do
    id=$(gh api "repos/$REPO/actions/workflows/$workflow/runs?branch=$ref&event=workflow_dispatch&per_page=1" \
      --jq '.workflow_runs[0].id // empty')
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
  local pending=("$@") next id status
  while [ "${#pending[@]}" -gt 0 ]; do
    next=()
    for id in "${pending[@]}"; do
      status=$(gh api "repos/$REPO/actions/runs/$id" --jq '.status')
      [ "$status" = "completed" ] || next+=("$id")
    done
    pending=("${next[@]+"${next[@]}"}")
    [ "${#pending[@]}" -eq 0 ] || sleep 120
  done
}

# Reads FABRIC_REPO, FABRIC_BRANCH, FABRIC_SHA, FABRIC_TAG, FABRIC_RUN_ID and
# TEST_RUNS (JSON array of {workflow, id}) from the environment.
report() {
  local out=${GITHUB_STEP_SUMMARY:-/dev/stdout} failed=0 runs id workflow conclusion url
  local cov_dir
  cov_dir=$(mktemp -d)
  runs=$(jq -c --arg id "${FABRIC_RUN_ID:-}" \
    '(if $id == "" then [] else [{workflow: "on-pr-fabric.yml", id: ($id|tonumber)}] end) + (env.TEST_RUNS // "[]" | fromjson)' <<<'null')

  {
    echo "## Fabric nightly"
    echo
    echo "- Branch: \`$FABRIC_BRANCH\` at [\`${FABRIC_SHA:0:9}\`](https://github.com/$FABRIC_REPO/commit/$FABRIC_SHA)"
    echo "- Latest tag: \`${FABRIC_TAG:-none}\`"
    echo
  } >>"$out"

  if [ -n "${FABRIC_TAG:-}" ]; then
    {
      echo "### Commits since ${FABRIC_TAG}"
      echo
      gh api "repos/$FABRIC_REPO/compare/$FABRIC_TAG...$FABRIC_SHA" \
        --jq '"\(.ahead_by) commits ahead\(if .ahead_by > 30 then ", latest 30 shown" else "" end):\n",
          (.commits | reverse | .[:30][] | "- [`\(.sha[:9])`](\(.html_url)) \(.commit.message | split("\n")[0])")'
      echo
    } >>"$out"
  fi

  {
    echo "### Runs"
    echo
    echo "| Workflow | Result | Run |"
    echo "|---|---|---|"
  } >>"$out"

  for row in $(jq -c '.[]' <<<"$runs"); do
    workflow=$(jq -r .workflow <<<"$row")
    id=$(jq -r .id <<<"$row")
    read -r conclusion url < <(gh api "repos/$REPO/actions/runs/$id" --jq '"\(.conclusion // .status) \(.html_url)"')
    [ "$conclusion" = "success" ] || failed=1
    echo "| $workflow | $conclusion | [$id]($url) |" >>"$out"
  done

  if [ "$(jq length <<<"${TEST_RUNS:-[]}")" -eq 0 ]; then
    echo >>"$out"
    echo "No consumer tests ran: the fabric build did not succeed." >>"$out"
  fi

  {
    echo
    echo "### Test results"
    echo
    echo "| Workflow | Job | Result |"
    echo "|---|---|---|"
  } >>"$out"
  for row in $(jq -c '.[]' <<<"${TEST_RUNS:-[]}"); do
    workflow=$(jq -r .workflow <<<"$row")
    id=$(jq -r .id <<<"$row")
    gh api --paginate "repos/$REPO/actions/runs/$id/jobs?per_page=100" \
      --jq '.jobs[]
        | select(.conclusion != "skipped")
        | select(.name | test("^(prebuild|cpp-tests|run-integration-tests|integration-tests) /"))
        | select(.name | test("Determine affected|runner_names|detect-reuse|/ merge$") | not)
        | "| '"$workflow"' | [\(.name)](\(.html_url)) | \(.conclusion // .status) |"' >>"$out"
  done

  {
    echo
    echo "### C++ line coverage"
    echo
    echo "| Workflow | Report | Lines |"
    echo "|---|---|---|"
  } >>"$out"
  for row in $(jq -c '.[]' <<<"${TEST_RUNS:-[]}"); do
    workflow=$(jq -r .workflow <<<"$row")
    id=$(jq -r .id <<<"$row")
    for name in $(gh api --paginate "repos/$REPO/actions/runs/$id/artifacts?per_page=100" \
      --jq '.artifacts[] | select(.name | test("coverage")) | .name'); do
      mkdir -p "$cov_dir/$id/$name"
      gh run download "$id" --repo "$REPO" --name "$name" --dir "$cov_dir/$id/$name" >/dev/null 2>&1 || continue
      while IFS= read -r summary; do
        pct=$(awk '/^TOTAL/ {print $10}' "$summary")
        [ -n "$pct" ] && echo "| $workflow | $name | $pct |" >>"$out"
      done < <(find "$cov_dir/$id/$name" -name coverage-summary.txt)
    done
  done

  return "$failed"
}

case "${1:-}" in
  dispatch) shift; dispatch "$@" ;;
  wait) shift; wait_runs "$@" ;;
  report) report ;;
  *) echo "usage: $0 dispatch|wait|report" >&2; exit 2 ;;
esac

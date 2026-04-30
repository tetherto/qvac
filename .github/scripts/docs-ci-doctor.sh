#!/usr/bin/env bash
#
# CI Doctor for docs workflows.
# Verifies all docs-related CI workflow runs are green for a given ref.
#
# Usage:
#   In CI (as PR gate on docs-production):
#     GH_TOKEN=... bash .github/scripts/docs-ci-doctor.sh <base_sha> <head_sha>
#
#   Locally (compare docs-production..main):
#     GH_TOKEN=... bash .github/scripts/docs-ci-doctor.sh
#
# Requires: gh CLI (https://cli.github.com)
# Environment: GH_TOKEN must be set with repo read access.

set -euo pipefail

REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q '.nameWithOwner')}"

BASE_SHA="${1:-}"
HEAD_SHA="${2:-}"

if [ -z "$HEAD_SHA" ]; then
  HEAD_SHA="$(git rev-parse HEAD)"
fi

DOCS_WORKFLOWS=(
  "Docs Website PR Checks"
  "Docs Post-Merge Sync"
)

printf "\n=== Docs CI Doctor ===\n"
printf "Repo:     %s\n" "$REPO"
printf "Head SHA: %s\n" "$HEAD_SHA"
if [ -n "$BASE_SHA" ]; then
  printf "Base SHA: %s\n" "$BASE_SHA"
fi
printf "\n"

HEAD_BRANCH=""
if [ -n "$GITHUB_HEAD_REF" ] 2>/dev/null; then
  HEAD_BRANCH="$GITHUB_HEAD_REF"
elif [ -n "$GITHUB_REF_NAME" ] 2>/dev/null; then
  HEAD_BRANCH="$GITHUB_REF_NAME"
else
  HEAD_BRANCH="main"
fi

TOTAL=0
PASSED=0
FAILED=0
MISSING=0
FAILED_NAMES=()

printf "%-35s  %-12s  %s\n" "WORKFLOW" "STATUS" "DETAILS"
printf "%-35s  %-12s  %s\n" "-----------------------------------" "------------" "-------"

for workflow_name in "${DOCS_WORKFLOWS[@]}"; do
  TOTAL=$((TOTAL + 1))

  run_json=$(gh api "repos/${REPO}/actions/runs" \
    --method GET \
    -f "branch=${HEAD_BRANCH}" \
    -f "per_page=5" \
    -f "event=push" \
    --jq ".workflow_runs[] | select(.name == \"${workflow_name}\") | {conclusion, html_url, head_sha, status}" \
    2>/dev/null | head -1) || true

  if [ -z "$run_json" ]; then
    run_json=$(gh api "repos/${REPO}/actions/runs" \
      --method GET \
      -f "branch=${HEAD_BRANCH}" \
      -f "per_page=10" \
      --jq ".workflow_runs[] | select(.name == \"${workflow_name}\") | {conclusion, html_url, head_sha, status}" \
      2>/dev/null | head -1) || true
  fi

  if [ -z "$run_json" ]; then
    printf "%-35s  %-12s  %s\n" "$workflow_name" "NOT FOUND" "No recent runs found"
    MISSING=$((MISSING + 1))
    FAILED_NAMES+=("$workflow_name (not found)")
    continue
  fi

  conclusion=$(echo "$run_json" | jq -r '.conclusion // "null"')
  status=$(echo "$run_json" | jq -r '.status // "unknown"')
  url=$(echo "$run_json" | jq -r '.html_url // ""')
  run_sha=$(echo "$run_json" | jq -r '.head_sha // ""')
  short_sha="${run_sha:0:7}"

  if [ "$status" = "in_progress" ] || [ "$status" = "queued" ]; then
    printf "%-35s  %-12s  %s\n" "$workflow_name" "RUNNING" "sha=${short_sha} ${url}"
    FAILED_NAMES+=("$workflow_name (still running)")
    FAILED=$((FAILED + 1))
  elif [ "$conclusion" = "success" ]; then
    printf "%-35s  %-12s  %s\n" "$workflow_name" "PASS" "sha=${short_sha}"
    PASSED=$((PASSED + 1))
  elif [ "$conclusion" = "skipped" ]; then
    printf "%-35s  %-12s  %s\n" "$workflow_name" "SKIPPED" "sha=${short_sha} (counted as pass)"
    PASSED=$((PASSED + 1))
  else
    printf "%-35s  %-12s  %s\n" "$workflow_name" "FAIL" "conclusion=${conclusion} sha=${short_sha} ${url}"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$workflow_name (${conclusion})")
  fi
done

printf "\n--- Summary ---\n"
printf "Total: %d  Passed: %d  Failed: %d  Missing: %d\n\n" "$TOTAL" "$PASSED" "$FAILED" "$MISSING"

if [ ${#FAILED_NAMES[@]} -gt 0 ]; then
  printf "Blocking issues:\n"
  for name in "${FAILED_NAMES[@]}"; do
    printf "  - %s\n" "$name"
  done
  printf "\nAll docs workflows must be green before merging to docs-production.\n"
  exit 1
fi

printf "All docs workflows are green.\n"
exit 0

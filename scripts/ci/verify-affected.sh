#!/usr/bin/env bash
# Shadow verifier for Phase A2: reproduces the EXACT output shape of the
# `changes` job in .github/workflows/pr-gate-merge.yml (dorny/paths-filter),
# but computed via `nx affected` instead. Used to prove nx's selection is a
# superset of dorny's over a burn-in window before A2/B1 promote it.
#
# Does NOT modify pr-gate-merge.yml or any existing workflow — this script
# and its CI shadow-job counterpart are purely additive.
#
# Usage: scripts/ci/verify-affected.sh <base-ref> [<head-ref>]
#   scripts/ci/verify-affected.sh origin/main HEAD
#
# Prints the same two JSON shapes dorny's `changes` job outputs:
#   packages:            ["llm-llamacpp","ocr-onnx",...]
#   packages-with-path:  [{"package":"llm-llamacpp","path":"packages/llm-llamacpp"},...]
# so they can be diffed directly against a live pr-gate-merge.yml run's
# `changes` job outputs.

set -euo pipefail

BASE="${1:?usage: verify-affected.sh <base-ref> [<head-ref>]}"
HEAD_ARG="${2:-}"

# Dorny's own filter keys in pr-gate-merge.yml, mapped to their real package
# dir name. Only "vla" differs from its dir name (packages/vla-ggml).
# This is the exact, live-verified set dorny tracks today - NOT the full
# nx-visible universe (37 projects). nx will legitimately report MORE
# affected projects than dorny for anything outside this set (e.g. pure-JS
# libs, decoder-audio's own file changes) - that's expected, not a bug;
# only look at nx's coverage OF THIS SET for the nx-superset-of-dorny check.
declare -A DORNY_KEY_TO_DIR=(
  [bci-whispercpp]=bci-whispercpp
  [classification-ggml]=classification-ggml
  [decoder-audio]=decoder-audio
  [diffusion-cpp]=diffusion-cpp
  [embed-llamacpp]=embed-llamacpp
  [llm-llamacpp]=llm-llamacpp
  [ocr-ggml]=ocr-ggml
  [ocr-onnx]=ocr-onnx
  [onnx]=onnx
  [transcription-parakeet]=transcription-parakeet
  [transcription-whispercpp]=transcription-whispercpp
  [translation-nmtcpp]=translation-nmtcpp
  [tts-ggml]=tts-ggml
  [fabric]=fabric
  [vla]=vla-ggml
)

# Omit --head entirely when not explicitly given so nx defaults to the
# working tree (uncommitted changes included) - passing --head=HEAD
# explicitly instead compares committed-HEAD-vs-committed-HEAD (no diff).
if [ -n "$HEAD_ARG" ]; then
  AFFECTED_JSON=$(nx show projects --affected --base="$BASE" --head="$HEAD_ARG" --json)
else
  AFFECTED_JSON=$(nx show projects --affected --base="$BASE" --json)
fi

PACKAGES=()
PACKAGES_WITH_PATH=()
for key in "${!DORNY_KEY_TO_DIR[@]}"; do
  dir="${DORNY_KEY_TO_DIR[$key]}"
  nx_name=$(node -e "const p=require('./packages/$dir/package.json'); console.log(p.name)" 2>/dev/null || echo "")
  if [ -z "$nx_name" ]; then continue; fi
  if echo "$AFFECTED_JSON" | jq -e --arg n "$nx_name" 'index($n) != null' > /dev/null; then
    PACKAGES+=("\"$key\"")
    PACKAGES_WITH_PATH+=("{\"package\":\"$key\",\"path\":\"packages/$dir\"}")
  fi
done

join_by() { local IFS="$1"; shift; echo "$*"; }

echo "packages=[$(join_by , "${PACKAGES[@]:-}")]"
echo "packages-with-path=[$(join_by , "${PACKAGES_WITH_PATH[@]:-}")]"
echo ""
echo "--- full nx affected set (repo-wide, for reference; dorny doesn't track most of these) ---"
echo "$AFFECTED_JSON" | jq -c 'sort'

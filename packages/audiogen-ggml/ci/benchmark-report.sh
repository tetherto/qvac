#!/usr/bin/env bash
# audiogen's benchmark report, as main's audiogen benchmark summary wrote it: one report over every
# desktop and mobile result in benchmarks/results and the checked-in manual rows, with the backend coverage map.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p benchmarks/report
node ../../scripts/perf-report/aggregate-audiogen-ggml-rtf.js \
  --dir benchmarks/results \
  --manual-dir benchmarks/manual-results \
  --run-id "${GITHUB_RUN_ID:-local}" \
  --output benchmarks/report/audiogen-ggml-performance-findings.md \
  --output-json benchmarks/report/audiogen-ggml-performance-findings.json
[ -n "${GITHUB_STEP_SUMMARY:-}" ] || exit 0
{
  cat benchmarks/report/audiogen-ggml-performance-findings.md
  echo ""
  echo "### Backend coverage map"
  echo ""
  echo "| Backend | Coverage | How |"
  echo "|---------|----------|-----|"
  echo "| cpu | linux x64/arm64, macOS arm64/x64, win32 x64 | desktop integration matrix |"
  echo "| vulkan | linux x64, win32 x64, Android (mobile) | qvac-*-gpu self-hosted runners + AWS Device Farm |"
  echo "| metal | macOS arm64, iOS flagships | qvac-macos26-arm64-gpu + AWS Device Farm |"
  echo "| mobile cpu | Android / iOS flagships | AWS Device Farm |"
  echo "| cuda | not in the default audiogen-cpp cascade | drop JSON into packages/audiogen-ggml/benchmarks/manual-results/ |"
  echo "| opencl | Adreno-only | drop JSON into packages/audiogen-ggml/benchmarks/manual-results/ |"
} >> "$GITHUB_STEP_SUMMARY"

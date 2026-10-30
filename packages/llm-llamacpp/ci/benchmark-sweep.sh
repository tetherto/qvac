#!/usr/bin/env bash
# The desktop parameter sweep, on this run's prebuilds. The mobile half runs
# through benchmarks.yml's mobile job, whose test:mobile picks the sweep's shards.
set -euo pipefail
cd "$(dirname "$0")/.."

gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | tr -d '\r' || true)
cd benchmarks/performance
npm install
node ./prepare-models.js --target addon
rc=0
npx --yes bare ./llm-parameter-sweep.js --addon-source local || rc=$?
mkdir -p results/parameter-sweep
printf '{"device":"Desktop (%s)"}\n' "${gpu:-GPU}" >results/parameter-sweep/desktop-meta.json

# Uploaded as this host's results; the report reads them with the mobile shards' perf reports.
mkdir -p ../results/llm-param-sweep-desktop
cp -r results/parameter-sweep/. ../results/llm-param-sweep-desktop/
exit "$rc"

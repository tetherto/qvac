#!/usr/bin/env bash
# The desktop parameter sweep, on this run's prebuilds. The mobile half runs
# through benchmarks.yml's mobile job, whose test:mobile picks the sweep's shards.
set -euo pipefail
cd "$(dirname "$0")/.."

gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | tr -d '\r' || true)
cd benchmarks/performance
npm install
models=()
if [ -n "$BM_MODELS" ]; then models=(--models "$BM_MODELS"); fi
node ./prepare-models.js --target addon "${models[@]}"
rc=0
npx --yes bare ./embed-parameter-sweep.js --addon-source local --repeats "${BM_REPEATS:-5}" "${models[@]}" || rc=$?
mkdir -p results/parameter-sweep
printf '{"device":"Desktop (%s)"}\n' "${gpu:-GPU}" >results/parameter-sweep/desktop-meta.json

mkdir -p ../results/embed-param-sweep-desktop
cp -r results/parameter-sweep/. ../results/embed-param-sweep-desktop/
exit "$rc"

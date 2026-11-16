#!/usr/bin/env bash
# The quality benchmark against transformers, on this run's prebuilds.
set -euo pipefail
cd "$(dirname "$0")/.."

nvidia-smi || echo "::warning::no NVIDIA GPU visible"
(cd benchmarks/server && npm install)
(cd benchmarks/client && python3 -m venv venv && . venv/bin/activate && pip install --upgrade pip && pip install -r requirements.txt)

args=(
  --gguf-model "$BM_GGUF_MODEL" --samples "$BM_NUM_SAMPLES" --datasets "$BM_DATASETS" --device "$BM_DEVICE"
  --temperature "$BM_TEMPERATURE" --ctx-size "$BM_CTX_SIZE" --gpu-layers "$BM_GPU_LAYERS" --top-p "$BM_TOP_P"
  --top-k "$BM_TOP_K" --n-predict "$BM_N_PREDICT" --repeat-penalty "$BM_REPEAT_PENALTY" --seed "$BM_SEED"
)
if [ -n "$BM_ADDON_VERSION" ]; then args+=(--addon-version "$BM_ADDON_VERSION"); fi
if [ -n "${HF_TOKEN:-}" ]; then
  echo "::add-mask::$HF_TOKEN"
  args+=(--hf-token "$HF_TOKEN")
fi
if [ "$BM_COMPARE" = true ]; then args+=(--compare --transformers-model "$BM_TRANSFORMERS_MODEL"); fi
if [ "$BM_VERBOSE" = true ]; then args+=(--verbose); fi
rc=0
./benchmarks/run-benchmarks.sh "${args[@]}" || rc=$?

# benchmarks/results is what the run uploads; the client and server logs ride along.
mkdir -p benchmarks/results/logs
cp -r benchmarks/client/logs benchmarks/results/logs/client 2>/dev/null || true
cp benchmarks/server/server.log benchmarks/results/logs/ 2>/dev/null || true
exit "$rc"

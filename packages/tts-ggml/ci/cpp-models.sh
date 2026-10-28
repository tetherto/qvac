#!/usr/bin/env bash
# tts's C++ test models, as cpp-tests-nx.yml made them: a Python venv converts the Hugging Face weights to the q4_0
# GGUFs the RealGguf tests read. A missing GGUF only warns; its gated tests skip.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/setup-venv.sh
bash scripts/convert-models.sh -t multilingual -q q4_0
bash scripts/convert-models.sh -t supertonic-en -q q4_0
for f in chatterbox-t3-mtl.gguf chatterbox-s3gen-mtl.gguf supertonic.gguf; do
  if [ ! -s "models/$f" ]; then
    echo "WARN: missing or empty models/$f -- gated tests will skip" >&2
  fi
done

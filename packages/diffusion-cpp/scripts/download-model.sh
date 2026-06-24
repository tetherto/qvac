#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

dl "$HF/leejet/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q8_0.gguf"        "$OUT/flux-2-klein-4b-Q8_0.gguf"
dl "$HF/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"                  "$OUT/Qwen3-4B-Q4_K_M.gguf"
dl "$HF/black-forest-labs/FLUX.2-klein-4B/resolve/main/vae/diffusion_pytorch_model.safetensors" "$OUT/flux2-vae.safetensors"

echo "done → $OUT"

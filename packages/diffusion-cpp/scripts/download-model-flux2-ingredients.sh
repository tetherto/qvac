#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

dl "$HF/unsloth/FLUX.2-klein-4B-GGUF/resolve/8342a6a97b2d18acae5d62124735c39ba23060e2/flux-2-klein-4b-Q8_0.gguf" "$OUT/flux-2-klein-4b-Q8_0.gguf"
dl "$HF/unsloth/Qwen3-4B-GGUF/resolve/22c9fc8a8c7700b76a1789366280a6a5a1ad1120/Qwen3-4B-Q4_K_M.gguf" "$OUT/Qwen3-4B-Q4_K_M.gguf"
dl "$HF/black-forest-labs/FLUX.2-klein-4B/resolve/main/vae/diffusion_pytorch_model.safetensors" "$OUT/flux2-vae.safetensors"

echo "done → $OUT"

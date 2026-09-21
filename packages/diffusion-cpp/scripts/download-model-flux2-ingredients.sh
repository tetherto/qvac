#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "HF_TOKEN is required because the FLUX.2 VAE is gated." >&2
  echo "Accept the license at $HF/black-forest-labs/FLUX.2-klein-4B, then export a Hugging Face read token." >&2
  exit 1
fi

mkdir -p "$OUT"
source "$SCRIPT_DIR/dl-functions.sh"

dl "$HF/leejet/FLUX.2-klein-4B-GGUF/resolve/3b1f5a9dc3abb32238b053aeb3d823c30afdacbd/flux-2-klein-4b-Q8_0.gguf" "$OUT/flux-2-klein-4b-Q8_0.gguf"
dl "$HF/unsloth/Qwen3-4B-GGUF/resolve/22c9fc8a8c7700b76a1789366280a6a5a1ad1120/Qwen3-4B-Q4_K_M.gguf" "$OUT/Qwen3-4B-Q4_K_M.gguf"
dl "$HF/black-forest-labs/FLUX.2-klein-4B/resolve/e7b7dc27f91deacad38e78976d1f2b499d76a294/vae/diffusion_pytorch_model.safetensors" "$OUT/flux2-vae.safetensors"

echo "done → $OUT"

#!/usr/bin/env bash
set -euo pipefail

# FLUX.2-klein-4B models for img2img pipeline
#
# Img2img uses the same model components as txt2img:
# - FLUX-2-klein-4B (Q8_0 quantized, 4.2GB) — main diffusion model
# - Qwen3-4B (Q4_K_M quantized, ~2.3GB) — text encoder
# - FLUX2 VAE (safetensors, ~150MB) — image encoder/decoder
#
# Total disk: ~6.7 GB    Estimated RAM: ~8-10 GB at runtime
# Optimized for MacBook Air M1 2020 (16GB RAM)
#
# Source: leejet/FLUX.2-klein-4B-GGUF (public, no auth)
#         unsloth/Qwen3-4B-GGUF (public, no auth)
#         black-forest-labs/FLUX.2-klein-4B (public, no auth)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

mkdir -p "$OUT"

dl() {
  local url="$1" dest="$2"
  [[ -f "$dest" ]] && echo "exists: $(basename "$dest")" && return
  echo "downloading: $(basename "$dest")"
  # -C - resumes a partial download; --retry retries on transient errors
  curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - -o "$dest" "$url" \
    || { rm -f "$dest"; exit 1; }
}

# FLUX-2-klein-4B Q8_0 — main diffusion model (4.2GB)
dl "$HF/leejet/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q8_0.gguf" \
   "$OUT/flux-2-klein-4b-Q8_0.gguf"

# Qwen3-4B Q4_K_M — text encoder (2.3GB)
# Note: fp4 safetensors is NOT supported by ggml, must use GGUF
dl "$HF/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf" \
   "$OUT/Qwen3-4B-Q4_K_M.gguf"

# FLUX2 VAE — image encoder/decoder for img2img (150MB)
dl "$HF/black-forest-labs/FLUX.2-klein-4B/resolve/main/vae/diffusion_pytorch_model.safetensors" \
   "$OUT/flux2-vae.safetensors"

echo "done → $OUT"

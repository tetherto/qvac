#!/usr/bin/env bash
set -euo pipefail

# Stable Diffusion XL Base 1.0 — GGUF Q8_0 (4.27 GB, no authentication required).
#
# Source: gpustack/stable-diffusion-xl-base-1.0-GGUF (public, no login needed)
# Converted from stabilityai/stable-diffusion-xl-base-1.0 using stable-diffusion.cpp.
#
# All-in-one file: CLIP-L, CLIP-G, UNet, and VAE are all baked in.
# No separate text encoder or VAE needed.
#
# Disk: ~4.27 GB    RAM: ~5.5 GB at runtime

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

dl "$HF/gpustack/stable-diffusion-xl-base-1.0-GGUF/resolve/main/stable-diffusion-xl-base-1.0-Q8_0.gguf" \
   "$OUT/stable-diffusion-xl-base-1.0-Q8_0.gguf"

echo "done → $OUT"

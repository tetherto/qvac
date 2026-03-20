#!/usr/bin/env bash
set -euo pipefail

# Stable Diffusion 2.1 — GGUF Q8_0 (2.32 GB, no authentication required).
#
# Source: gpustack/stable-diffusion-v2-1-GGUF (public, no login needed)
# Converted from stabilityai/stable-diffusion-2-1 using stable-diffusion.cpp.
#
# All-in-one file: no separate text encoder or VAE needed.
# Disk: ~2.32 GB    RAM: ~3.5 GB at runtime

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

mkdir -p "$OUT"

dl() {
  local url="$1" dest="$2"
  [[ -f "$dest" ]] && echo "exists: $(basename "$dest")" && return
  echo "downloading: $(basename "$dest")"
  curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - -o "$dest" "$url" \
    || { rm -f "$dest"; exit 1; }
}

dl "$HF/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q8_0.gguf" \
   "$OUT/stable-diffusion-v2-1-Q8_0.gguf"

echo "done → $OUT"

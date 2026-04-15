#!/usr/bin/env bash
set -euo pipefail

# FLUX.2-klein-4B F16 models for img2img pipeline
#
# F16 (full precision) models equivalent to Iris safetensors quality
# Use these to reduce quantization bias while staying in GGUF format
#
# Components:
# - FLUX-2-klein-4B (F16, ~8GB) — main diffusion model, full precision
# - Qwen3-4B (F16 or Q8, ~4.5GB) — text encoder
# - FLUX2 VAE (safetensors, ~160MB) — image encoder/decoder
#
# Total disk: ~12-13 GB    Estimated RAM: ~16-20 GB at runtime
# Optimized for systems with 32GB+ RAM (e.g., M3 Ultra)
#
# Source: unsloth/FLUX.2-klein-4B-GGUF (public, no auth)
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

# FLUX-2-klein-4B F16 — main diffusion model (8GB, full precision)
echo "Downloading FLUX-2-klein-4B F16 (full precision, ~8GB)..."
dl "$HF/unsloth/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-F16.gguf" \
   "$OUT/flux-2-klein-4b-F16.gguf"

# Qwen3-4B Q8 — text encoder (4.5GB, high quality quantization)
# Note: F16 version is ~9GB, Q8 is good balance between size and quality
echo "Downloading Qwen3-4B Q8 text encoder (~4.5GB)..."
dl "$HF/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q8_0.gguf" \
   "$OUT/Qwen3-4B-Q8_0.gguf"

# FLUX2 VAE — image encoder/decoder for img2img (160MB)
echo "Downloading FLUX2 VAE..."
dl "$HF/black-forest-labs/FLUX.2-klein-4B/resolve/main/vae/diffusion_pytorch_model.safetensors" \
   "$OUT/flux2-vae.safetensors"

echo ""
echo "✓ Download complete!"
echo ""
echo "Models saved to: $OUT"
echo "  - flux-2-klein-4b-F16.gguf (transformer, F16 full precision)"
echo "  - Qwen3-4B-Q8_0.gguf (text encoder, Q8 high quality)"
echo "  - flux2-vae.safetensors (VAE)"
echo ""
echo "These F16 models have much less quantization bias than Q8/Q4."
echo "Update your script to use: flux-2-klein-4b-F16.gguf"

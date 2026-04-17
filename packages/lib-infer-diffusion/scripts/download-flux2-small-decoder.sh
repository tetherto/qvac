#!/usr/bin/env bash
set -euo pipefail

# FLUX.2 Small Decoder — more efficient VAE decoder for FLUX.2
#
# This is an alternative VAE decoder for FLUX.2 models that aims to be
# more efficient while maintaining quality. Can be used as a drop-in
# replacement for the standard flux2-vae.safetensors.
#
# According to Black Forest Labs:
# - diffusion_pytorch_model.safetensors: Standard diffusers format (compatible with stable-diffusion.cpp)
# - full_encoder_small_decoder.safetensors: Combo file for ComfyUI (encoder + decoder)
# - small_decoder.safetensors: Decoder-only (not compatible with stable-diffusion.cpp)
#
# We download diffusion_pytorch_model.safetensors as it's the standard format.
#
# Source: black-forest-labs/FLUX.2-small-decoder (public, no auth)
#         https://huggingface.co/black-forest-labs/FLUX.2-small-decoder

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

# FLUX.2 Small Decoder (diffusers format, ~160MB)
# This is saved with a different name so it doesn't overwrite the standard VAE
dl "$HF/black-forest-labs/FLUX.2-small-decoder/resolve/main/diffusion_pytorch_model.safetensors" \
   "$OUT/flux2-small-decoder.safetensors"

echo ""
echo "✓ Downloaded FLUX.2 small decoder → $OUT/flux2-small-decoder.safetensors"
echo ""
echo "To use this decoder, change your img2img-flux2.js to:"
echo "  vaeModel: 'flux2-small-decoder.safetensors'"
echo ""
echo "Original VAE (flux2-vae.safetensors) is unchanged, so you can switch back anytime."

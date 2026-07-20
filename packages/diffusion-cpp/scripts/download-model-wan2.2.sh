#!/usr/bin/env bash
set -euo pipefail

# Wan 2.2 TI2V-5B Turbo downloader.
#
# Downloads the single supported Wan 2.2 layout: the community-distilled
# Q5_K_S Turbo GGUF plus its fp16 UMT5-XXL encoder and Wan 2.2 VAE.
#
# Usage:
#   ./scripts/download-model-wan2.2.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"
TURBO_REPO="hum-ma/Wan2.2-TI2V-5B-Turbo-GGUF"
TURBO_REV="9873ba175b4b204a81f4a43c9644e6c385ee4459"
COMPANION_REPO="Comfy-Org/Wan_2.2_ComfyUI_Repackaged"
COMPANION_REV="fb1388adc906ab39ffc26ee40e96b22886b56bc4"
TURBO_MODEL="Wan2_2-TI2V-5B-Turbo-Q5_K_S.gguf"

if (( $# > 0 )); then
  echo "Usage: download-model-wan2.2.sh" >&2
  exit 1
fi

mkdir -p "$OUT"
source "$SCRIPT_DIR/dl-functions.sh"

echo "Downloading Wan 2.2 TI2V-5B Turbo (Q5_K_S) to $OUT"
dl "$HF/$TURBO_REPO/resolve/$TURBO_REV/$TURBO_MODEL" "$OUT/$TURBO_MODEL"
dl "$HF/$COMPANION_REPO/resolve/$COMPANION_REV/split_files/vae/wan2.2_vae.safetensors" \
  "$OUT/wan2.2_vae.safetensors"
dl "$HF/$COMPANION_REPO/resolve/$COMPANION_REV/split_files/text_encoders/umt5_xxl_fp16.safetensors" \
  "$OUT/umt5_xxl_fp16.safetensors"

echo "done → $OUT"

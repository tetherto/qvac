#!/usr/bin/env bash
set -euo pipefail

# Wan 2.1 Video Generation Models
#
# Source: Comfy-Org/Wan_2.1_ComfyUI_repackaged
#         Official Wan 2.1 video generation model repackaged for ComfyUI.
#
# Files downloaded:
#   wan2.1_t2v_1.3B_fp16.safetensors    2.5 GB
#     Diffusion model for text-to-video generation (fastest, smallest model)
#
#   wan_2.1_vae.safetensors              1.2 GB
#     Variational Autoencoder for video encoding/decoding
#
#   umt5_xxl_fp16.safetensors            4.6 GB
#     UMT5-XXL text encoder for prompt understanding
#
# Total: ~8.3 GB | Time to download: 30-60 minutes depending on speed
# Disk: ~8.3 GB | RAM: ~6-8 GB at runtime with Metal GPU acceleration
# Minimum recommended: 12 GB unified memory
#
# Video generation command example:
#   ./sd-cli -M vid_gen \
#     --diffusion-model models/wan2.1_t2v_1.3B_fp16.safetensors \
#     --vae models/wan_2.1_vae.safetensors \
#     --t5xxl models/umt5_xxl_fp16.safetensors \
#     -p "your prompt here" \
#     -o output.mp4

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"
REPO="Comfy-Org/Wan_2.1_ComfyUI_repackaged"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

# Diffusion model for text-to-video generation
dl "$HF/$REPO/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors" \
   "$OUT/wan2.1_t2v_1.3B_fp16.safetensors"

# VAE for video encoding/decoding
dl "$HF/$REPO/resolve/main/split_files/vae/wan_2.1_vae.safetensors" \
   "$OUT/wan_2.1_vae.safetensors"

# Text encoder for prompt understanding
dl "$HF/$REPO/resolve/main/split_files/text_encoders/umt5_xxl_fp16.safetensors" \
   "$OUT/umt5_xxl_fp16.safetensors"

echo "done → $OUT"

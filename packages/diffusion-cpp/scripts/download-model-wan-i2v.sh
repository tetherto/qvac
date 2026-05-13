#!/usr/bin/env bash
set -euo pipefail

# Wan 2.1 Image-to-Video (I2V) Models — 14B dedicated I2V checkpoint
#
# Source: Comfy-Org/Wan_2.1_ComfyUI_repackaged
#         Official Wan 2.1 I2V checkpoints repackaged for ComfyUI.
#
# Unlike download-model-wan.sh (which pulls the 1.3B *T2V* model that the
# examples reuse as a stand-in for img2vid), this script grabs the proper
# 14B I2V checkpoint that Wan 2.1 ships specifically for img2vid / flf2vid
# style generation.
#
# Variants (override via env vars; defaults shown):
#
#   WAN_I2V_RESOLUTION   480p | 720p                       (default: 480p)
#   WAN_I2V_PRECISION    fp16 | bf16 | fp8_e4m3fn | fp8_scaled
#                                                          (default: fp8_scaled)
#
# Diffusion model size by precision:
#   fp16          32.8 GB    highest quality, very large
#   bf16          32.8 GB    same size as fp16
#   fp8_e4m3fn    16.4 GB    simple fp8 quantization
#   fp8_scaled    16.4 GB    scaled fp8 — best quality/size tradeoff (default)
#
# Always-downloaded companions (shared with the t2v script):
#   wan_2.1_vae.safetensors          1.2 GB   video VAE encoder/decoder
#   umt5_xxl_fp16.safetensors        4.6 GB   UMT5-XXL text encoder
#
# Defaults: 480p + fp8_scaled
#   Disk:   ~22 GB total
#   RAM:    ~20-24 GB at runtime with Metal GPU acceleration
#   Min recommended: 32 GB unified memory
#
# Image-to-video command example:
#   ./sd-cli -M vid_gen \
#     --diffusion-model models/wan2.1_i2v_480p_14B_fp8_scaled.safetensors \
#     --vae models/wan_2.1_vae.safetensors \
#     --t5xxl models/umt5_xxl_fp16.safetensors \
#     -i input.png \
#     -p "your prompt here" \
#     -o output.mp4
#
# Examples:
#   ./download-model-wan-i2v.sh                                # 480p fp8_scaled (default)
#   WAN_I2V_PRECISION=fp16 ./download-model-wan-i2v.sh         # 480p fp16
#   WAN_I2V_RESOLUTION=720p ./download-model-wan-i2v.sh        # 720p fp8_scaled
#   WAN_I2V_RESOLUTION=720p WAN_I2V_PRECISION=fp16 ./download-model-wan-i2v.sh

RESOLUTION="${WAN_I2V_RESOLUTION:-480p}"
PRECISION="${WAN_I2V_PRECISION:-fp8_scaled}"

case "$RESOLUTION" in
  480p|720p) ;;
  *)
    echo "error: WAN_I2V_RESOLUTION must be '480p' or '720p' (got: '$RESOLUTION')" >&2
    exit 2
    ;;
esac

case "$PRECISION" in
  fp16|bf16|fp8_e4m3fn|fp8_scaled) ;;
  *)
    echo "error: WAN_I2V_PRECISION must be one of: fp16, bf16, fp8_e4m3fn, fp8_scaled (got: '$PRECISION')" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"
REPO="Comfy-Org/Wan_2.1_ComfyUI_repackaged"

DIFFUSION_FILE="wan2.1_i2v_${RESOLUTION}_14B_${PRECISION}.safetensors"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

echo "Wan 2.1 I2V — resolution=$RESOLUTION precision=$PRECISION"
echo "  diffusion model → $DIFFUSION_FILE"
echo

# I2V diffusion model (14B, dedicated img2vid checkpoint)
dl "$HF/$REPO/resolve/main/split_files/diffusion_models/$DIFFUSION_FILE" \
   "$OUT/$DIFFUSION_FILE"

# VAE for video encoding/decoding (shared with t2v)
dl "$HF/$REPO/resolve/main/split_files/vae/wan_2.1_vae.safetensors" \
   "$OUT/wan_2.1_vae.safetensors"

# Text encoder for prompt understanding (shared with t2v)
dl "$HF/$REPO/resolve/main/split_files/text_encoders/umt5_xxl_fp16.safetensors" \
   "$OUT/umt5_xxl_fp16.safetensors"

echo "done → $OUT"

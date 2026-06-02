#!/usr/bin/env bash
set -euo pipefail

# Wan 2.1 Image-to-Video (I2V) Models — 14B dedicated I2V checkpoint
#
# stable-diffusion.cpp natively supports GGUF quantisation (Q4_K_M, Q8_0,
# etc.).  The fp8_scaled safetensors format is a ComfyUI-only variant that
# requires per-tensor scale application during inference; the C++ library
# ignores those scale tensors and produces near-zero velocity predictions,
# making GGUF the correct format for this project.
#
# Variants (override via env vars; defaults shown):
#
#   WAN_I2V_RESOLUTION   480p | 720p          (default: 480p)
#   WAN_I2V_QUANT        Q4_K_M | Q8_0 | F16  (default: Q4_K_M)
#   WAN_I2V_FORMAT       gguf | safetensors    (default: gguf)
#
# When FORMAT=gguf (default):
#   Source: city96/Wan2.1-I2V-14B-480P-gguf (or 720P variant)
#   Q4_K_M   11.3 GB  — recommended, good quality/size tradeoff
#   Q8_0     15.8 GB  — near-lossless
#   F16      28.7 GB  — full precision (large)
#
# When FORMAT=safetensors (legacy, NOT recommended):
#   Source: Comfy-Org/Wan_2.1_ComfyUI_repackaged
#   fp8_scaled 16.4 GB — note: scale factors ignored by stable-diffusion.cpp
#
# Always-downloaded companions (shared with the t2v script):
#   wan_2.1_vae.safetensors          1.2 GB   video VAE encoder/decoder
#   umt5_xxl_fp16.safetensors        4.6 GB   UMT5-XXL text encoder
#   clip_vision_h.safetensors        ~0.6 GB  OpenCLIP ViT-H/14 (I2V only)
#
# Defaults: 480p Q4_K_M GGUF — ~17.2 GB total disk
#
# Examples:
#   ./download-model-wan-i2v.sh                                # 480p Q4_K_M (default)
#   WAN_I2V_QUANT=Q8_0 ./download-model-wan-i2v.sh             # 480p Q8_0
#   WAN_I2V_RESOLUTION=720p ./download-model-wan-i2v.sh        # 720p Q4_K_M
#   WAN_I2V_FORMAT=safetensors ./download-model-wan-i2v.sh     # legacy fp8_scaled

RESOLUTION="${WAN_I2V_RESOLUTION:-480p}"
QUANT="${WAN_I2V_QUANT:-Q4_K_M}"
FORMAT="${WAN_I2V_FORMAT:-gguf}"

case "$RESOLUTION" in
  480p|720p) ;;
  *)
    echo "error: WAN_I2V_RESOLUTION must be '480p' or '720p' (got: '$RESOLUTION')" >&2
    exit 2
    ;;
esac

case "$FORMAT" in
  gguf|safetensors) ;;
  *)
    echo "error: WAN_I2V_FORMAT must be 'gguf' or 'safetensors' (got: '$FORMAT')" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

if [ "$FORMAT" = "gguf" ]; then
  RES_UPPER="$(echo "$RESOLUTION" | tr '[:lower:]' '[:upper:]')"
  RES_LOWER="$(echo "$RESOLUTION" | tr '[:upper:]' '[:lower:]')"
  GGUF_REPO="city96/Wan2.1-I2V-14B-${RES_UPPER}-gguf"
  DIFFUSION_FILE="wan2.1-i2v-14b-${RES_LOWER}-${QUANT}.gguf"

  echo "Wan 2.1 I2V — resolution=$RESOLUTION format=gguf quant=$QUANT"
  echo "  diffusion model → $DIFFUSION_FILE (from $GGUF_REPO)"
  echo

  dl "$HF/$GGUF_REPO/resolve/main/$DIFFUSION_FILE" \
     "$OUT/$DIFFUSION_FILE"
else
  # Legacy safetensors path (fp8_scaled)
  PRECISION="${WAN_I2V_PRECISION:-fp8_scaled}"
  COMFY_REPO="Comfy-Org/Wan_2.1_ComfyUI_repackaged"
  DIFFUSION_FILE="wan2.1_i2v_${RESOLUTION}_14B_${PRECISION}.safetensors"

  echo "Wan 2.1 I2V — resolution=$RESOLUTION format=safetensors precision=$PRECISION"
  echo "  WARNING: fp8_scaled scale factors are ignored by stable-diffusion.cpp"
  echo "  diffusion model → $DIFFUSION_FILE"
  echo

  dl "$HF/$COMFY_REPO/resolve/main/split_files/diffusion_models/$DIFFUSION_FILE" \
     "$OUT/$DIFFUSION_FILE"
fi

# VAE for video encoding/decoding (shared with t2v)
dl "$HF/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors" \
   "$OUT/wan_2.1_vae.safetensors"

# Text encoder for prompt understanding (shared with t2v)
dl "$HF/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp16.safetensors" \
   "$OUT/umt5_xxl_fp16.safetensors"

# CLIP vision encoder — required for I2V image conditioning (OpenCLIP ViT-H/14)
dl "$HF/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors" \
   "$OUT/clip_vision_h.safetensors"

echo "done → $OUT"
echo "  diffusion model: $DIFFUSION_FILE"

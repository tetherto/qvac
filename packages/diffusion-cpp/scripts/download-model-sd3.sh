#!/usr/bin/env bash
set -euo pipefail

# Stable Diffusion 3 Medium — official safetensors (ungated mirror).
#
# Source: adamo1139/stable-diffusion-3-medium-ungated
#         Ungated re-upload of the official stabilityai/stable-diffusion-3-medium
#         weights.  No HuggingFace account or token required.
#
# File downloaded:
#   sd3_medium_incl_clips.safetensors    5.97 GB
#     All-in-one: diffusion model + CLIP-L + CLIP-G text encoders.
#     No T5-XXL — text-following quality is slightly lower but RAM usage is
#     comfortable on 16 GB unified memory.
#
# Optional — better quality with T5-XXL (adds ~4.9 GB download + ~5 GB RAM):
#   Uncomment the t5xxl download block below and use generate-image-sd3-split.js.
#
# Disk: ~6.0 GB    RAM: ~7–8 GB at runtime (without T5-XXL)
# Minimum recommended: 12 GB unified memory

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"
REPO="adamo1139/stable-diffusion-3-medium-ungated"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

# All-in-one: diffusion model + CLIP-L + CLIP-G (no T5-XXL)
dl "$HF/$REPO/resolve/main/sd3_medium_incl_clips.safetensors" \
   "$OUT/sd3_medium_incl_clips.safetensors"

# Optional: T5-XXL FP8 for much better prompt understanding (~4.89 GB)
# Uncomment to download:
# dl "$HF/$REPO/resolve/main/text_encoders/t5xxl_fp8_e4m3fn.safetensors" \
#    "$OUT/t5xxl_fp8_e4m3fn.safetensors"

echo "done → $OUT"

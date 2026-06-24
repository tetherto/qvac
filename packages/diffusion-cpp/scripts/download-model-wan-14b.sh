#!/usr/bin/env bash
set -euo pipefail

# Wan 2.1 T2V 14B Q8_0 — quantized text-to-video diffusion model
#
# Sources:
#   city96/Wan2.1-T2V-14B-gguf
#     Community Q8_0 GGUF quantization of the official 14B T2V checkpoint.
#     ~10x the parameters of the 1.3B baseline downloaded by
#     download-model-wan.sh, with noticeably better motion coherence,
#     prompt adherence, and per-frame detail.
#
#   Comfy-Org/Wan_2.1_ComfyUI_repackaged
#     Source of the shared VAE and UMT5-XXL text encoder. These are the
#     *same files* used by the 1.3B example, so the script skips the
#     download if they already exist on disk (dl-functions.sh handles
#     the existence check). Only the diffusion model changes between
#     the 1.3B and 14B configurations.
#
# Files downloaded:
#   wan2.1_t2v_14B_Q8_0.gguf            ~16 GB
#     Quantized 14B diffusion model (Q8_0 GGUF). Replaces
#     wan2.1_t2v_1.3B_fp16.safetensors in the generation command.
#
#   wan_2.1_vae.safetensors              1.2 GB   (skipped if already present)
#   umt5_xxl_fp16.safetensors            4.6 GB   (skipped if already present)
#
# Total: ~16 GB if you already ran download-model-wan.sh,
#        ~22 GB otherwise.
# Time to download: 60-120 minutes depending on connection speed.
# Disk: ~22 GB | RAM: ~18-24 GB at runtime with GPU acceleration
# Minimum recommended: 24 GB unified memory / 16 GB VRAM + offload-to-cpu.
#
# Video generation command example:
#   ./sd-cli -M vid_gen \
#     --diffusion-model models/wan2.1_t2v_14B_Q8_0.gguf \
#     --vae models/wan_2.1_vae.safetensors \
#     --t5xxl models/umt5_xxl_fp16.safetensors \
#     -p "your prompt here" \
#     -o output.mp4
#
# Or via the bundled JS example (set the env var to swap the model file):
#   DIFFUSION_MODEL=wan2.1_t2v_14B_Q8_0.gguf \
#     bare examples/generate-video-wan.js
#
# Note: generation is ~3x slower than the 1.3B baseline. Plan for
# ~15-20 minutes per 5-7 second video at 60 steps on a single
# RTX 4090 / 5090, or ~30+ minutes without flash attention.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

# Diffusion-model repo (community Q8_0 GGUF)
DM_REPO="city96/Wan2.1-T2V-14B-gguf"
DM_FILE="wan2.1-t2v-14b-Q8_0.gguf"

# Shared encoder/VAE repo (same as the 1.3B model — files are reused)
SHARED_REPO="Comfy-Org/Wan_2.1_ComfyUI_repackaged"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

# Quantized 14B diffusion model
dl "$HF/$DM_REPO/resolve/main/$DM_FILE" \
   "$OUT/wan2.1_t2v_14B_Q8_0.gguf"

# VAE for video encoding/decoding (shared with 1.3B)
dl "$HF/$SHARED_REPO/resolve/main/split_files/vae/wan_2.1_vae.safetensors" \
   "$OUT/wan_2.1_vae.safetensors"

# Text encoder for prompt understanding (shared with 1.3B)
dl "$HF/$SHARED_REPO/resolve/main/split_files/text_encoders/umt5_xxl_fp16.safetensors" \
   "$OUT/umt5_xxl_fp16.safetensors"

echo "done → $OUT"

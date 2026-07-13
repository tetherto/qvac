#!/usr/bin/env bash
set -euo pipefail

# Ideogram 4 (GGUF) model files for stable-diffusion.cpp.
#
# Layout mirrors the FLUX.2 split-model setup: a diffusion model + a separate
# text encoder + a VAE. Ideogram 4 additionally ships a second *unconditional*
# diffusion model used for classifier-free guidance.
#
# Reference command (leejet/ideogram-4-GGUF):
#   sd-cli --diffusion-model         ideogram4-Q4_0.gguf \
#          --uncond-diffusion-model  ideogram4_uncond-Q4_0.gguf \
#          --llm                     Qwen3-VL-8B-Instruct-Q4_K_M.gguf \
#          --vae                     flux2-vae.safetensors \
#          -p '{...structured JSON prompt...}' \
#          --diffusion-fa -v --offload-to-cpu -H 1024 -W 1024
#
# Files (≈16 GB total on disk):
#   ideogram4-Q4_0.gguf              ~5.6 GB  Ideogram 4 diffusion model (Q4_0)
#   ideogram4_uncond-Q4_0.gguf       ~5.6 GB  Unconditional diffusion model (CFG)
#   Qwen3-VL-8B-Instruct-Q4_K_M.gguf ~5.0 GB  Qwen3-VL text encoder
#   flux2-vae.safetensors            ~336 MB  FLUX.2-family VAE (shared)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

# -- Ideogram 4 diffusion weights (download these first) ----------------------
dl "$HF/leejet/ideogram-4-GGUF/resolve/c93c0ac616d3abc7910c9af0bf117244ce3a11c4/ideogram4-Q4_0.gguf"        "$OUT/ideogram4-Q4_0.gguf"
dl "$HF/leejet/ideogram-4-GGUF/resolve/c93c0ac616d3abc7910c9af0bf117244ce3a11c4/ideogram4_uncond-Q4_0.gguf" "$OUT/ideogram4_uncond-Q4_0.gguf"

# -- Text encoder (Qwen3-VL 8B Instruct) --------------------------------------
dl "$HF/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/b93a7ee713758252c555be4210c00540df954dc2/Qwen3-VL-8B-Instruct-Q4_K_M.gguf" "$OUT/Qwen3-VL-8B-Instruct-Q4_K_M.gguf"

# -- VAE (FLUX.2 family; reused if already present from the FLUX.2 script) -----
dl "$HF/black-forest-labs/FLUX.2-klein-4B/resolve/e7b7dc27f91deacad38e78976d1f2b499d76a294/vae/diffusion_pytorch_model.safetensors" "$OUT/flux2-vae.safetensors"

echo "done → $OUT"

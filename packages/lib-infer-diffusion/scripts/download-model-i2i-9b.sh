#!/usr/bin/env bash
set -euo pipefail

# FLUX.2-klein-9B models for img2img pipeline (larger / higher-fidelity
# alternative to download-model-i2i.sh which fetches the 4B variant).
#
# Img2img uses the same model components as txt2img:
# - FLUX-2-klein-9B  (Q8_0 quantized, ~10 GB) — main diffusion model
# - Qwen3-8B         (Q4_K_M quantized, ~5 GB) — text encoder
# - FLUX2 VAE        (safetensors,      ~150 MB) — image encoder/decoder
#
# Total disk: ~15 GB    Estimated RAM: ~16-20 GB at runtime (Q8_0)
# Recommended on machines with >= 24 GB unified memory. On 16 GB machines
# use the Q4_0 variant (see DIFFUSION_QUANT below) — ~11 GB disk, ~12 GB RAM.
#
# Source: leejet/FLUX.2-klein-9B-GGUF         (public, no auth)
#         unsloth/Qwen3-8B-GGUF               (public, no auth)
#         black-forest-labs/FLUX.2-klein-9B   (public, no auth — VAE only)

# ── Config ─────────────────────────────────────────────────────────────────
# Override the diffusion-model quantization by setting DIFFUSION_QUANT=Q4_0
# in the environment (e.g. `DIFFUSION_QUANT=Q4_0 ./download-model-i2i-9b.sh`).
DIFFUSION_QUANT="${DIFFUSION_QUANT:-Q8_0}"

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

# FLUX-2-klein-9B — main diffusion model
# Q8_0: 9.98 GB (higher fidelity, preferred)
# Q4_0: 5.62 GB (fits in 16 GB RAM machines)
DIFFUSION_FILE="flux-2-klein-9b-${DIFFUSION_QUANT}.gguf"
dl "$HF/leejet/FLUX.2-klein-9B-GGUF/resolve/main/${DIFFUSION_FILE}" \
   "$OUT/${DIFFUSION_FILE}"

# Qwen3-8B Q4_K_M — text encoder (~5 GB)
# Note: fp4 safetensors is NOT supported by ggml, must use GGUF.
# The 9B FLUX variant pairs with the 8B Qwen3 text encoder (vs Qwen3-4B for
# the 4B FLUX variant) — see docs/flux2.md in stable-diffusion.cpp.
dl "$HF/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf" \
   "$OUT/Qwen3-8B-Q4_K_M.gguf"

# FLUX2 VAE — image encoder/decoder (~150 MB).
# Same VAE as the 4B variant; if download-model-i2i.sh already pulled it,
# the dl() helper above will short-circuit on the "exists" check.
dl "$HF/black-forest-labs/FLUX.2-klein-9B/resolve/main/vae/diffusion_pytorch_model.safetensors" \
   "$OUT/flux2-vae.safetensors"

echo "done → $OUT"
echo ""
echo "To use these weights, update your example to:"
echo "  modelName : 'flux-2-klein-9b-${DIFFUSION_QUANT}.gguf'"
echo "  llmModel  : 'Qwen3-8B-Q4_K_M.gguf'"
echo "  vaeModel  : 'flux2-vae.safetensors'"

#!/usr/bin/env bash
set -euo pipefail

# LTX-2.3 Video Generation Model (GGUF Quantized)
#
# Source: QuantStack/LTX-2.3-GGUF
#         Community quantized GGUF conversion for consumer hardware.
#         Supports video + audio generation in a single model.
#
# Model Variants:
#   LTX-2.3-dev          - Full model, higher quality, needs 20+ steps
#   LTX-2.3-distilled    - Optimized for 4-8 steps, faster
#   LTX-2.3-distilled-1.1 - Improved distilled version (RECOMMENDED)
#
# Available quantization levels:
#   Q2_K   (~12.4 GB)
#   Q3_K_S (~14.0 GB)
#   Q3_K_M (~14.7 GB)
#   Q4_K_S (~16.7 GB)
#   Q4_K_M (~17.8 GB)
#   Q5_K_S (~18.5 GB)
#   Q5_K_M (~19.4 GB) - DEFAULT (size/quality balance)
#   Q6_K   (~21.0 GB)
#   Q8_0   (~25.5 GB) - Best quality
#
# Usage:
#   ./download-model-ltx.sh              # Downloads distilled-1.1 Q5_K_M (default)
#   ./download-model-ltx.sh --dev        # Use dev model instead
#   ./download-model-ltx.sh --distilled  # Use basic distilled model
#   ./download-model-ltx.sh --q4ks       # Downloads Q4_K_S
#   ./download-model-ltx.sh --q4ks --q5km # Downloads multiple quantizations
#   ./download-model-ltx.sh --all        # Downloads all quantizations
#
# Note: LTX-2.3 is a 21B parameter model designed for efficient video+audio generation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"
REPO="QuantStack/LTX-2.3-GGUF"

mkdir -p "$OUT"

source "$SCRIPT_DIR/dl-functions.sh"

# Parse command line arguments
QUANTIZATIONS=()
DOWNLOAD_ALL=false
MODEL_VARIANT="distilled-1.1"  # default

for arg in "$@"; do
  case "$arg" in
    --dev) MODEL_VARIANT="dev" ;;
    --distilled) MODEL_VARIANT="distilled" ;;
    --all) DOWNLOAD_ALL=true ;;
    --q2k) QUANTIZATIONS+=("Q2_K") ;;
    --q3ks) QUANTIZATIONS+=("Q3_K_S") ;;
    --q3km) QUANTIZATIONS+=("Q3_K_M") ;;
    --q4ks) QUANTIZATIONS+=("Q4_K_S") ;;
    --q4km) QUANTIZATIONS+=("Q4_K_M") ;;
    --q5ks) QUANTIZATIONS+=("Q5_K_S") ;;
    --q5km) QUANTIZATIONS+=("Q5_K_M") ;;
    --q6k) QUANTIZATIONS+=("Q6_K") ;;
    --q80) QUANTIZATIONS+=("Q8_0") ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# If --all, download all quantizations
if [ "$DOWNLOAD_ALL" = true ]; then
  QUANTIZATIONS=("Q2_K" "Q3_K_S" "Q3_K_M" "Q4_K_S" "Q4_K_M" "Q5_K_S" "Q5_K_M" "Q6_K" "Q8_0")
fi

# If no quantizations specified, default to Q5_K_M (size/quality balance)
if [ ${#QUANTIZATIONS[@]} -eq 0 ]; then
  QUANTIZATIONS=("Q5_K_M")
fi

echo "LTX-2.3 GGUF Model Download"
echo "============================="
echo "Variant: $MODEL_VARIANT"
echo "Quantizations: ${QUANTIZATIONS[@]}"
echo "Output directory: $OUT"
echo ""

# Determine folder name based on variant
case "$MODEL_VARIANT" in
  dev)
    FOLDER="LTX-2.3-dev"
    PREFIX="LTX-2.3-dev"
    ;;
  distilled-1.1)
    FOLDER="LTX-2.3-distilled-1.1"
    PREFIX="LTX-2.3-22B-distilled-1.1"
    ;;
  distilled)
    FOLDER="LTX-2.3-distilled"
    PREFIX="LTX-2.3-distilled"
    ;;
esac

# Download each quantization
for quant in "${QUANTIZATIONS[@]}"; do
  filename="${PREFIX}-${quant}.gguf"
  url="$HF/$REPO/resolve/main/$FOLDER/$filename"
  output_path="$OUT/$filename"
  
  dl "$url" "$output_path"
done

# ---------------------------------------------------------------------------
# LTX runtime components (required in addition to the diffusion model)
#
# A working LTX-2.3 pipeline needs more than the diffusion transformer:
#   - video VAE + audio VAE         (latent <-> pixel/audio)
#   - embeddings connectors         (text-encoder -> transformer adapter)
#   - gemma-3-12b-it text encoder   (the --llm prompt encoder)
#
# The QuantStack repo only ships the diffusion GGUFs, so the VAE/connectors
# come from unsloth/LTX-2.3-GGUF and the text encoder from
# unsloth/gemma-3-12b-it-GGUF. The Gemma *tokenizer* is compiled into sd-cli,
# so it is not downloaded here.
# ---------------------------------------------------------------------------

# Map diffusion variant -> aux variant published by unsloth (only dev / distilled)
case "$MODEL_VARIANT" in
  dev) AUX_VARIANT="dev" ;;
  *)   AUX_VARIANT="distilled" ;;
esac

UNSLOTH_LTX="unsloth/LTX-2.3-GGUF"
GEMMA_REPO="unsloth/gemma-3-12b-it-GGUF"
GEMMA_FILE="${GEMMA_FILE:-gemma-3-12b-it-UD-Q4_K_XL.gguf}"

echo ""
echo "Downloading LTX runtime components (variant: $AUX_VARIANT)..."

# Video VAE
dl "$HF/$UNSLOTH_LTX/resolve/main/vae/ltx-2.3-22b-${AUX_VARIANT}_video_vae.safetensors" \
   "$OUT/ltx-2.3-22b-${AUX_VARIANT}_video_vae.safetensors"

# Audio VAE
dl "$HF/$UNSLOTH_LTX/resolve/main/vae/ltx-2.3-22b-${AUX_VARIANT}_audio_vae.safetensors" \
   "$OUT/ltx-2.3-22b-${AUX_VARIANT}_audio_vae.safetensors"

# Embeddings connectors (text encoder -> transformer adapter)
dl "$HF/$UNSLOTH_LTX/resolve/main/text_encoders/ltx-2.3-22b-${AUX_VARIANT}_embeddings_connectors.safetensors" \
   "$OUT/ltx-2.3-22b-${AUX_VARIANT}_embeddings_connectors.safetensors"

# Gemma-3-12b-it text encoder (--llm)
dl "$HF/$GEMMA_REPO/resolve/main/$GEMMA_FILE" \
   "$OUT/$GEMMA_FILE"

echo ""
echo "✓ Done → $OUT"
echo ""
echo "LTX files present:"
ls -lh "$OUT"/*ltx* "$OUT"/*LTX* "$OUT"/gemma-3-12b* 2>/dev/null || echo "No LTX models found"

#!/usr/bin/env bash
set -euo pipefail

# Multi-reference FLUX2 image generation script
# Combines two reference images using multi-reference conditioning
# Example: ./multi-ref-flux2-anime.sh headshot.jpeg marco.png

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SD_CLI="${PROJECT_ROOT}/temp/stable-diffusion.cpp/build_metal/bin/sd-cli"
MODELS_DIR="${PROJECT_ROOT}/models"

# Default values
STEPS=5
CFG_SCALE=1.0
SEED=-1
OUTPUT_FILE="./goku_fusion.png"

# Model names
MODEL="flux-2-klein-4b-Q8_0.gguf"
VAE="flux2-vae.safetensors"
LLM="Qwen3-4B-Q4_K_M.gguf"

# Validate CLI binary exists
if [ ! -x "$SD_CLI" ]; then
  echo "Error: sd-cli binary not found at $SD_CLI"
  exit 1
fi

# Validate models directory exists
if [ ! -d "$MODELS_DIR" ]; then
  echo "Error: Models directory not found at $MODELS_DIR"
  exit 1
fi

# Check arguments
if [ $# -lt 2 ]; then
  echo "Usage: $0 <image1.png> <image2.png> [output_file]"
  echo ""
  echo "Example: $0 headshot.jpeg marco.png"
  echo "Example: $0 headshot.jpeg marco.png /tmp/output.png"
  exit 1
fi

IMAGE1="$1"
IMAGE2="$2"

if [ $# -ge 3 ]; then
  OUTPUT_FILE="$3"
fi

# Validate input images exist
if [ ! -f "$IMAGE1" ]; then
  echo "Error: Image 1 not found: $IMAGE1"
  exit 1
fi

if [ ! -f "$IMAGE2" ]; then
  echo "Error: Image 2 not found: $IMAGE2"
  exit 1
fi

# Validate models exist
if [ ! -f "${MODELS_DIR}/${MODEL}" ]; then
  echo "Error: Model not found: ${MODELS_DIR}/${MODEL}"
  exit 1
fi

if [ ! -f "${MODELS_DIR}/${VAE}" ]; then
  echo "Error: VAE not found: ${MODELS_DIR}/${VAE}"
  exit 1
fi

if [ ! -f "${MODELS_DIR}/${LLM}" ]; then
  echo "Error: LLM not found: ${MODELS_DIR}/${LLM}"
  exit 1
fi

echo "=========================================="
echo "Multi-Reference FLUX2 Generation"
echo "=========================================="
echo ""
echo "Configuration:"
echo "  Model         : $MODEL"
echo "  VAE           : $VAE"
echo "  LLM           : $LLM"
echo "  Reference 1   : $IMAGE1"
echo "  Reference 2   : $IMAGE2"
echo "  Steps         : $STEPS"
echo "  CFG Scale     : $CFG_SCALE"
echo "  Seed          : $SEED"
echo "  Output        : $OUTPUT_FILE"
echo ""
echo "Prompt:"
echo "  Black studio background, dynamic lightining, mixed/fusion version of @image1 and @image2 merged into a single person, like a hyper-realistic version of @image1 and @image2 from dragonball z"
echo ""
echo "Starting generation..."
echo "=========================================="
echo ""

# Run the sd-cli with multi-reference
# Optimizations:
#   --diffusion-fa: Flash attention for faster computation
#   --sampling-method euler: Recommended for FLUX2 models
#   Additional optimizations can be added: --offload-to-cpu, --vae-tiling, etc.
"$SD_CLI" \
  --diffusion-model "${MODELS_DIR}/${MODEL}" \
  --vae "${MODELS_DIR}/${VAE}" \
  --llm "${MODELS_DIR}/${LLM}" \
  --ref-image "$IMAGE1" \
  --ref-image "$IMAGE2" \
  -p "Black studio background, dynamic lightining, mixed/fusion version of @image1 and @image2 merged into a single person, like a hyper-realistic version of @image1 and @image2 from dragonball z" \
  --cfg-scale "$CFG_SCALE" \
  --steps "$STEPS" \
  --seed "$SEED" \
  --sampling-method euler \
  --diffusion-fa \
  -o "$OUTPUT_FILE"

echo ""
echo "=========================================="
echo "✓ Generation complete!"
echo "✓ Output saved to: $OUTPUT_FILE"
echo "=========================================="

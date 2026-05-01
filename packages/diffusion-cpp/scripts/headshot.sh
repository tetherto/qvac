#!/usr/bin/env bash
set -euo pipefail

# FLUX2-klein img2img script for headshot transformation
# Transforms the input headshot using FLUX2-klein-4B models

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SD_BIN="$BASE_DIR/temp/stable-diffusion.cpp/build/bin/sd-cli"
MODELS_DIR="$BASE_DIR/models"
INPUT_IMG="$BASE_DIR/temp/nik_headshot.jpeg"
OUTPUT_IMG="$BASE_DIR/temp/nik_transformed.png"

# Check if stable-diffusion.cpp binary exists
if [[ ! -f "$SD_BIN" ]]; then
  echo "Error: stable-diffusion.cpp binary not found at: $SD_BIN"
  echo "Please build stable-diffusion.cpp first:"
  echo "  cd $BASE_DIR/temp/stable-diffusion.cpp"
  echo "  mkdir -p build && cd build"
  echo "  cmake .. -DGGML_METAL=ON && cmake --build . --config Release"
  exit 1
fi

# Check if models exist
if [[ ! -f "$MODELS_DIR/flux-2-klein-4b-Q8_0.gguf" ]]; then
  echo "Error: FLUX2 model not found. Run: ./scripts/download-model-i2i.sh"
  exit 1
fi

if [[ ! -f "$INPUT_IMG" ]]; then
  echo "Error: Input image not found at: $INPUT_IMG"
  exit 1
fi

echo "Running FLUX2-klein img2img..."
echo "Input:  $INPUT_IMG"
echo "Output: $OUTPUT_IMG"
echo ""

"$SD_BIN" \
  --diffusion-model "$MODELS_DIR/flux-2-klein-4b-Q8_0.gguf" \
  --llm "$MODELS_DIR/Qwen3-4B-Q4_K_M.gguf" \
  --vae "$MODELS_DIR/flux2-vae.safetensors" \
  --prediction flux2_flow \
  --mode img_gen \
  --init-img "$INPUT_IMG" \
  --output "$OUTPUT_IMG" \
  --prompt "change my hairstyle to long hair, and do not do anything else" \
  --negative-prompt "blurry, low quality, distorted" \
  --strength 0.30 \
  --steps 40 \
  --guidance 9.0 \
  --sampling-method euler \
  --seed 42

echo ""
echo "Done! Output saved to: $OUTPUT_IMG"

#!/usr/bin/env bash
set -euo pipefail

# Download MiniMax-H3 FL2VA GGUF components for qvac diffusion-cpp.
# H3 produces video and native stereo audio. The Q2 encoder pairs with Q2;
# Q3 and Q4 use the Q4 encoder.
#
# Usage:
#   ./scripts/download-model-minimax-h3.sh          # Q4 (default)
#   ./scripts/download-model-minimax-h3.sh --q2
#   ./scripts/download-model-minimax-h3.sh --q3
#   MODELS_DIR=/path/to/models ./scripts/download-model-minimax-h3.sh --q4

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="${MODELS_DIR:-$PACKAGE_DIR/models/minimax-h3}"
HF_REPO="unsloth/MiniMax-H3-GGUF"
H3_REV="${H3_REV:-main}"
QUANT="q4"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--q2|--q3|--q4]

Downloads the MiniMax-H3 FL2VA denoiser, matching Qwen3-VL text encoder,
video VAE, and audio VAE into: $MODELS_DIR

Environment:
  MODELS_DIR  destination directory
  H3_REV      Hugging Face revision (default: main)
  HF_TOKEN    optional Hugging Face token
EOF
}

for arg in "$@"; do
  case "$arg" in
    --q2) QUANT="q2" ;;
    --q3) QUANT="q3" ;;
    --q4) QUANT="q4" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

source "$SCRIPT_DIR/dl-functions.sh"
mkdir -p "$MODELS_DIR/vae"

case "$QUANT" in
  q2)
    DIFFUSION_FILE="minimax_h3_fl2va_pruned-Q2_K.gguf"
    DIFFUSION_SIZE=6724190304
    LLM_FILE="qwen3vl_32b_minimax_h3-Q2_K_M.gguf"
    LLM_SIZE=13102161024
    ;;
  q3)
    DIFFUSION_FILE="minimax_h3_fl2va_pruned-Q3_K.gguf"
    DIFFUSION_SIZE=8759328864
    LLM_FILE="qwen3vl_32b_minimax_h3-Q4_K_M.gguf"
    LLM_SIZE=18218065024
    ;;
  q4)
    DIFFUSION_FILE="minimax_h3_fl2va_pruned-Q4_K.gguf"
    DIFFUSION_SIZE=11420663904
    LLM_FILE="qwen3vl_32b_minimax_h3-Q4_K_M.gguf"
    LLM_SIZE=18218065024
    ;;
esac

fetch_verified() {
  local relative_path="$1"
  local expected_size="$2"
  local destination="$MODELS_DIR/$relative_path"
  local url="https://huggingface.co/$HF_REPO/resolve/$H3_REV/$relative_path"
  local partial="$destination.partial"

  if [[ -f "$destination" ]] && [[ "$(stat -c %s "$destination")" == "$expected_size" ]]; then
    echo "verified: $relative_path"
    return
  fi

  rm -f "$destination"
  mkdir -p "$(dirname "$destination")"
  if [[ -n "${HF_TOKEN:-}" ]]; then
    curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - \
      -H "Authorization: Bearer $HF_TOKEN" -o "$partial" "$url"
  else
    curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - \
      -o "$partial" "$url"
  fi
  if [[ "$(stat -c %s "$partial")" != "$expected_size" ]]; then
    echo "size verification failed for $relative_path" >&2
    rm -f "$partial"
    exit 1
  fi
  mv "$partial" "$destination"
  echo "verified: $relative_path"
}

fetch_verified "$DIFFUSION_FILE" "$DIFFUSION_SIZE"
fetch_verified "$LLM_FILE" "$LLM_SIZE"
fetch_verified "vae/minimax_h3_video_vae_fp16.safetensors" 5207808496
fetch_verified "vae/minimax_h3_audio_vae_fp32.safetensors" 605254808

cat <<EOF

MiniMax-H3 $QUANT model set is ready in: $MODELS_DIR

Use text-to-audio-video mode with all four paths, cfg_scale 1.0, guidance 7.0,
and 24 FPS. MiniMax-H3 aligns frame counts to 17*k + 5.
EOF

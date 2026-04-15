#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
MODELS_DIR="${PACKAGE_DIR}/models"

mkdir -p "$MODELS_DIR"

MODEL_NAME="ggml-tiny.en.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"
MODEL_PATH="${MODELS_DIR}/${MODEL_NAME}"

if [ -f "$MODEL_PATH" ]; then
  echo "Model already exists: ${MODEL_PATH}"
else
  echo "Downloading ${MODEL_NAME}..."
  curl -L "$MODEL_URL" -o "$MODEL_PATH"
  echo "Downloaded to: ${MODEL_PATH}"
fi

echo "Done."

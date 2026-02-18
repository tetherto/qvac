#!/bin/bash

set -e

MODELS_DIR="./models"
WHISPER_REPO="ggerganov/whisper.cpp"
VAD_REPO="ggml-org/whisper-vad"
HF_BASE="https://huggingface.co"

echo "Creating models directory..."
mkdir -p "$MODELS_DIR"

download_file() {
  local url=$1
  local dest=$2

  if [ -f "$dest" ]; then
    echo "  Already exists: $(basename $dest), skipping"
    return
  fi

  echo "  Downloading $(basename $dest)..."
  curl -L -o "$dest" "$url"
}

echo "Which Whisper model would you like to download?"
echo ""
echo "1) tiny       - Smallest, fastest (~78 MB)"
echo "2) base       - Balanced size/accuracy (~148 MB)"
echo "3) small      - Better accuracy (~488 MB)"
echo "4) medium     - High accuracy (~1.5 GB)"
echo "5) large-v3   - Best accuracy (~3.1 GB)"
echo "6) large-v3-turbo - Best accuracy, faster (~1.6 GB)"
echo ""
echo "Quantized variants:"
echo "7) tiny-q8_0  - Quantized tiny (~44 MB)"
echo "8) base-q8_0  - Quantized base (~82 MB)"
echo "9) small-q8_0 - Quantized small (~264 MB)"
echo ""
echo "VAD model:"
echo "10) silero-vad - Voice Activity Detection model (~885 KB)"
echo ""
echo "Bundles:"
echo "11) tiny + vad  (recommended for development)"
echo "12) All standard models + vad"
echo ""
read -p "Enter your choice (1-12): " choice

download_whisper_model() {
  local model_file=$1
  download_file "${HF_BASE}/${WHISPER_REPO}/resolve/main/${model_file}" "${MODELS_DIR}/${model_file}"
}

download_vad_model() {
  download_file "${HF_BASE}/${VAD_REPO}/resolve/main/ggml-silero-v5.1.2.bin" "${MODELS_DIR}/ggml-silero-v5.1.2.bin"
}

case $choice in
  1) download_whisper_model "ggml-tiny.bin" ;;
  2) download_whisper_model "ggml-base.bin" ;;
  3) download_whisper_model "ggml-small.bin" ;;
  4) download_whisper_model "ggml-medium.bin" ;;
  5) download_whisper_model "ggml-large-v3.bin" ;;
  6) download_whisper_model "ggml-large-v3-turbo.bin" ;;
  7) download_whisper_model "ggml-tiny-q8_0.bin" ;;
  8) download_whisper_model "ggml-base-q8_0.bin" ;;
  9) download_whisper_model "ggml-small-q8_0.bin" ;;
  10) download_vad_model ;;
  11)
    download_whisper_model "ggml-tiny.bin"
    download_vad_model
    ;;
  12)
    for model in ggml-tiny.bin ggml-base.bin ggml-small.bin ggml-medium.bin ggml-large-v3.bin ggml-large-v3-turbo.bin; do
      download_whisper_model "$model"
    done
    download_vad_model
    ;;
  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
echo "========================================="
echo "Download complete!"
echo "========================================="
echo ""
echo "Models downloaded to: $MODELS_DIR"
echo ""
echo "You can now run the example:"
echo "  bare examples/quickstart.js"
echo ""

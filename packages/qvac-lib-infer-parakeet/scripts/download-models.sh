#!/bin/bash

# Script to download Parakeet models from Hugging Face

set -e

MODELS_DIR="./models"

echo "Creating models directory..."
mkdir -p "$MODELS_DIR"

# Function to download a model
download_model() {
  local model_name=$1
  local repo=$2
  local files=("${@:3}")
  
  echo ""
  echo "========================================="
  echo "Downloading $model_name..."
  echo "========================================="
  
  local model_dir="$MODELS_DIR/$model_name"
  mkdir -p "$model_dir"
  
  for file in "${files[@]}"; do
    echo "Downloading $file..."
    local url="https://huggingface.co/$repo/resolve/main/$file"
    curl -L -o "$model_dir/$(basename $file)" "$url"
  done
  
  echo "✓ $model_name downloaded successfully"
}

# Ask user which model to download
echo "Which Parakeet model would you like to download?"
echo ""
echo "1) TDT (Multilingual, ~25 languages, recommended)"
echo "2) CTC (English-only, faster)"
echo "3) EOU (Streaming with end-of-utterance detection)"
echo "4) All models"
echo ""
read -p "Enter your choice (1-4): " choice

case $choice in
  1)
    download_model "parakeet-tdt-0.6b-v3-onnx" \
      "istupakov/parakeet-tdt-0.6b-v3-onnx" \
      "encoder-model.onnx" \
      "encoder-model.onnx.data" \
      "decoder_joint-model.onnx" \
      "vocab.txt"
    
    # Download preprocessor (required for accurate mel spectrogram)
    echo "Downloading preprocessor.onnx..."
    curl -L -o "$MODELS_DIR/parakeet-tdt-0.6b-v3-onnx/preprocessor.onnx" \
      "https://huggingface.co/ysdede/parakeet-tdt-0.6b-v2-onnx/resolve/main/nemo128.onnx"
    echo "✓ preprocessor.onnx downloaded"
    ;;
  2)
    download_model "parakeet-ctc-0.6b-onnx" \
      "onnx-community/parakeet-ctc-0.6b-ONNX" \
      "onnx/model.onnx" \
      "onnx/model.onnx_data" \
      "onnx/tokenizer.json"
    ;;
  3)
    download_model "parakeet-eou-120m-v1-onnx" \
      "altunene/parakeet-rs" \
      "realtime_eou_120m-v1-onnx/encoder.onnx" \
      "realtime_eou_120m-v1-onnx/decoder_joint.onnx" \
      "realtime_eou_120m-v1-onnx/tokenizer.json"
    ;;
  4)
    download_model "parakeet-tdt-0.6b-v3-onnx" \
      "istupakov/parakeet-tdt-0.6b-v3-onnx" \
      "encoder-model.onnx" \
      "encoder-model.onnx.data" \
      "decoder_joint-model.onnx" \
      "vocab.txt"
    
    # Download preprocessor for TDT model
    echo "Downloading preprocessor.onnx..."
    curl -L -o "$MODELS_DIR/parakeet-tdt-0.6b-v3-onnx/preprocessor.onnx" \
      "https://huggingface.co/ysdede/parakeet-tdt-0.6b-v2-onnx/resolve/main/nemo128.onnx"
    echo "✓ preprocessor.onnx downloaded"
    
    download_model "parakeet-ctc-0.6b-onnx" \
      "onnx-community/parakeet-ctc-0.6b-ONNX" \
      "onnx/model.onnx" \
      "onnx/model.onnx_data" \
      "onnx/tokenizer.json"
    
    download_model "parakeet-eou-120m-v1-onnx" \
      "altunene/parakeet-rs" \
      "realtime_eou_120m-v1-onnx/encoder.onnx" \
      "realtime_eou_120m-v1-onnx/decoder_joint.onnx" \
      "realtime_eou_120m-v1-onnx/tokenizer.json"
    ;;
  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
echo "========================================="
echo "All downloads complete!"
echo "========================================="
echo ""
echo "You can now run the example:"
echo "  bare examples/transcribe.js"
echo ""


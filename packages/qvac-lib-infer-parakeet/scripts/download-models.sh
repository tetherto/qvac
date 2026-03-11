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

rename_sortformer() {
  local src="$MODELS_DIR/sortformer-4spk-v2-onnx/diar_streaming_sortformer_4spk-v2.onnx"
  local dst="$MODELS_DIR/sortformer-4spk-v2-onnx/sortformer.onnx"
  if [ -f "$dst" ]; then
    return 0
  fi
  if [ ! -f "$src" ]; then
    echo "ERROR: Sortformer download failed — source file not found"
    exit 1
  fi
  mv "$src" "$dst" || exit 1
}

# Ask user which model to download
echo "Which Parakeet model would you like to download?"
echo ""
echo "1) TDT (Multilingual, ~25 languages, recommended)"
echo "2) CTC (English-only, faster)"
echo "3) EOU (Streaming with end-of-utterance detection)"
echo "4) Sortformer (Speaker diarization, up to 4 speakers)"
echo "5) All models"
echo ""
read -p "Enter your choice (1-5): " choice

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
      "onnx/model.onnx_data"
    # tokenizer.json lives at repo root, not inside onnx/
    echo "Downloading tokenizer.json..."
    curl -L -o "$MODELS_DIR/parakeet-ctc-0.6b-onnx/tokenizer.json" \
      "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/tokenizer.json"
    echo "✓ tokenizer.json downloaded"
    ;;
  3)
    download_model "parakeet-eou-120m-v1-onnx" \
      "altunenes/parakeet-rs" \
      "realtime_eou_120m-v1-onnx/encoder.onnx" \
      "realtime_eou_120m-v1-onnx/decoder_joint.onnx" \
      "realtime_eou_120m-v1-onnx/tokenizer.json"
    ;;
  4)
    download_model "sortformer-4spk-v2-onnx" \
      "cgus/diar_streaming_sortformer_4spk-v2-onnx" \
      "diar_streaming_sortformer_4spk-v2.onnx"
    rename_sortformer
    ;;
  5)
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
      "onnx/model.onnx_data"
    echo "Downloading tokenizer.json..."
    curl -L -o "$MODELS_DIR/parakeet-ctc-0.6b-onnx/tokenizer.json" \
      "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/tokenizer.json"
    echo "✓ tokenizer.json downloaded"
    
    download_model "parakeet-eou-120m-v1-onnx" \
      "altunenes/parakeet-rs" \
      "realtime_eou_120m-v1-onnx/encoder.onnx" \
      "realtime_eou_120m-v1-onnx/decoder_joint.onnx" \
      "realtime_eou_120m-v1-onnx/tokenizer.json"
    
    download_model "sortformer-4spk-v2-onnx" \
      "cgus/diar_streaming_sortformer_4spk-v2-onnx" \
      "diar_streaming_sortformer_4spk-v2.onnx"
    rename_sortformer
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


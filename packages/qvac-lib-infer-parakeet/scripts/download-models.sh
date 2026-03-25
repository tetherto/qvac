#!/bin/bash

# Script to download Parakeet models from Hugging Face

set -e

MODELS_DIR="./models"

echo "Creating models directory..."
mkdir -p "$MODELS_DIR"

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo ""
  fi
}

extract_lfs_sha256() {
  local json=$1
  local filename=$2
  python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for item in data:
    if item.get('path','').endswith('$filename'):
        lfs = item.get('lfs')
        if lfs and 'oid' in lfs:
            print(lfs['oid'])
            sys.exit(0)
sys.exit(1)
" <<< "$json" 2>/dev/null
}

verify_file() {
  local dest=$1
  local repo=$2
  local file=$3

  local actual_sha
  actual_sha=$(compute_sha256 "$dest")
  if [ -z "$actual_sha" ]; then
    echo "  WARNING: sha256sum not available, skipping integrity check"
    return 0
  fi

  local dir_path
  dir_path=$(dirname "$file")
  local tree_path="main"
  if [ "$dir_path" != "." ]; then
    tree_path="main/${dir_path}"
  fi

  local basename_file
  basename_file=$(basename "$file")

  local metadata
  metadata=$(curl -sL "https://huggingface.co/api/models/${repo}/tree/${tree_path}")

  local expected_sha
  expected_sha=$(extract_lfs_sha256 "$metadata" "$basename_file")

  if [ -z "$expected_sha" ]; then
    echo "  WARNING: could not fetch LFS checksum from HuggingFace (file may not be LFS-tracked), skipping integrity check"
    return 0
  fi

  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "  ERROR: checksum mismatch for $(basename "$dest")"
    echo "    expected: $expected_sha"
    echo "    actual:   $actual_sha"
    rm -f "$dest"
    return 1
  fi

  echo "  Verified: $(basename "$dest") (SHA-256 OK)"
  return 0
}

download_and_verify() {
  local url=$1
  local dest=$2
  local repo=$3
  local file=$4

  echo "Downloading $file..."
  curl -L -o "$dest" "$url"

  if [ -n "$repo" ] && [ -n "$file" ]; then
    verify_file "$dest" "$repo" "$file"
  fi
}

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
    local url="https://huggingface.co/$repo/resolve/main/$file"
    download_and_verify "$url" "$model_dir/$(basename $file)" "$repo" "$file"
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
    download_and_verify \
      "https://huggingface.co/ysdede/parakeet-tdt-0.6b-v2-onnx/resolve/main/nemo128.onnx" \
      "$MODELS_DIR/parakeet-tdt-0.6b-v3-onnx/preprocessor.onnx" \
      "ysdede/parakeet-tdt-0.6b-v2-onnx" \
      "nemo128.onnx"
    ;;
  2)
    download_model "parakeet-ctc-0.6b-onnx" \
      "onnx-community/parakeet-ctc-0.6b-ONNX" \
      "onnx/model.onnx" \
      "onnx/model.onnx_data"
    # tokenizer.json lives at repo root, not inside onnx/
    download_and_verify \
      "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/tokenizer.json" \
      "$MODELS_DIR/parakeet-ctc-0.6b-onnx/tokenizer.json" \
      "onnx-community/parakeet-ctc-0.6b-ONNX" \
      "tokenizer.json"
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
    download_and_verify \
      "https://huggingface.co/ysdede/parakeet-tdt-0.6b-v2-onnx/resolve/main/nemo128.onnx" \
      "$MODELS_DIR/parakeet-tdt-0.6b-v3-onnx/preprocessor.onnx" \
      "ysdede/parakeet-tdt-0.6b-v2-onnx" \
      "nemo128.onnx"
    
    download_model "parakeet-ctc-0.6b-onnx" \
      "onnx-community/parakeet-ctc-0.6b-ONNX" \
      "onnx/model.onnx" \
      "onnx/model.onnx_data"
    download_and_verify \
      "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/main/tokenizer.json" \
      "$MODELS_DIR/parakeet-ctc-0.6b-onnx/tokenizer.json" \
      "onnx-community/parakeet-ctc-0.6b-ONNX" \
      "tokenizer.json"
    
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


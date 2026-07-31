#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADDON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ADDON_DIR"

REGISTRY_BUCKET="${MODEL_S3_BUCKET:-}"
if [ -z "$REGISTRY_BUCKET" ]; then
  echo "ERROR: MODEL_S3_BUCKET env var is required (the S3 bucket holding the QVAC model registry)." >&2
  exit 1
fi

MODELS_DIR="models"
REGISTRY_PREFIX_Q8_0="qvac_models_compiled/ggml/parakeet/2026-05-11"
REGISTRY_PREFIX_Q4_0="qvac_models_compiled/ggml/parakeet/2026-05-27"
REGISTRY_PREFIX_2026_07_01="qvac_models_compiled/ggml/parakeet/2026-07-01"
REGISTRY_PREFIX_STREAMING="qvac_models_compiled/ggml/parakeet/2026-05-20"

Q4_CTC_FILES=(
  "parakeet-ctc-0.6b.q4_0.gguf"
)
Q4_FILES=(
  "parakeet-tdt-0.6b-v3.q4_0.gguf"
  "parakeet-eou-120m-v1.q4_0.gguf"
  "sortformer-4spk-v1.q4_0.gguf"
)
Q8_FILES=(
  "parakeet-ctc-0.6b.q8_0.gguf"
  "parakeet-tdt-0.6b-v3.q8_0.gguf"
  "parakeet-eou-120m-v1.q8_0.gguf"
  "sortformer-4spk-v1.q8_0.gguf"
)
STREAMING_FILES=(
  "diar_streaming_sortformer_4spk-v2.1.q4_0.gguf"
  "diar_streaming_sortformer_4spk-v2.1.q8_0.gguf"
)
ALL_FILES=("${Q4_CTC_FILES[@]}" "${Q4_FILES[@]}" "${Q8_FILES[@]}" "${STREAMING_FILES[@]}")

download_models_from_prefix() {
  local prefix="$1"
  shift
  for f in "$@"; do
    if [ -s "$MODELS_DIR/$f" ]; then
      echo "[$(basename "$0")] ✓ $f already present in $MODELS_DIR/"
      continue
    fi
    echo "[$(basename "$0")] Downloading $f from s3://$REGISTRY_BUCKET/$prefix/"
    aws s3 cp "s3://$REGISTRY_BUCKET/$prefix/$f" "$MODELS_DIR/$f"
  done
}

mkdir -p "$MODELS_DIR"

download_models_from_prefix "$REGISTRY_PREFIX_2026_07_01" "${Q4_CTC_FILES[@]}"
download_models_from_prefix "$REGISTRY_PREFIX_Q4_0" "${Q4_FILES[@]}"
download_models_from_prefix "$REGISTRY_PREFIX_Q8_0" "${Q8_FILES[@]}"
download_models_from_prefix "$REGISTRY_PREFIX_STREAMING" "${STREAMING_FILES[@]}"

echo ""
echo "[$(basename "$0")] Downloaded GGUFs:"
ls -lh "$MODELS_DIR"/*.gguf

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
TEST_ASSETS_DIR="test/mobile/testAssets"
REGISTRY_PREFIX_DEFAULT="qvac_models_compiled/ggml/parakeet/2026-05-27"
REGISTRY_PREFIX_STREAMING="qvac_models_compiled/ggml/parakeet/2026-05-20"

DEFAULT_FILES=(
  "parakeet-tdt-0.6b-v3.q4_0.gguf"
  "parakeet-eou-120m-v1.q4_0.gguf"
  "sortformer-4spk-v1.q4_0.gguf"
)
STREAMING_FILES=(
  "diar_streaming_sortformer_4spk-v2.1.q4_0.gguf"
)
ALL_FILES=("${DEFAULT_FILES[@]}" "${STREAMING_FILES[@]}")

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

stage_models_into_test_assets() {
  for f in "$@"; do
    if [ ! -s "$MODELS_DIR/$f" ]; then
      echo "ERROR: missing or empty $MODELS_DIR/$f -- registry download may have failed" >&2
      ls -la "$MODELS_DIR/" || true
      exit 1
    fi
    cp "$MODELS_DIR/$f" "$TEST_ASSETS_DIR/"
  done
}

mkdir -p "$MODELS_DIR" "$TEST_ASSETS_DIR"

download_models_from_prefix "$REGISTRY_PREFIX_DEFAULT" "${DEFAULT_FILES[@]}"
download_models_from_prefix "$REGISTRY_PREFIX_STREAMING" "${STREAMING_FILES[@]}"

echo ""
echo "[$(basename "$0")] Downloaded GGUFs:"
ls -lh "$MODELS_DIR"/*.q4_0.gguf

stage_models_into_test_assets "${ALL_FILES[@]}"

echo "[$(basename "$0")] Staged GGUFs in $TEST_ASSETS_DIR/:"
ls -lh "$TEST_ASSETS_DIR/"

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

REGISTRY_PREFIX="qvac_models_compiled/ggml/parakeet/2026-05-11"
MODELS_DIR="models"
TEST_ASSETS_DIR="test/mobile/testAssets"
Q4_FILES=(
  "parakeet-tdt-0.6b-v3.q4_0.gguf"
  "parakeet-eou-120m-v1.q4_0.gguf"
  "sortformer-4spk-v1.q4_0.gguf"
)

mkdir -p "$MODELS_DIR" "$TEST_ASSETS_DIR"

for f in "${Q4_FILES[@]}"; do
  if [ -s "$MODELS_DIR/$f" ]; then
    echo "[$(basename "$0")] ✓ $f already present in $MODELS_DIR/"
    continue
  fi
  echo "[$(basename "$0")] Downloading $f from s3://$REGISTRY_BUCKET/$REGISTRY_PREFIX/"
  aws s3 cp "s3://$REGISTRY_BUCKET/$REGISTRY_PREFIX/$f" "$MODELS_DIR/$f"
done

echo ""
echo "[$(basename "$0")] Downloaded GGUFs:"
ls -lh "$MODELS_DIR"/*.q4_0.gguf

for f in "${Q4_FILES[@]}"; do
  if [ ! -s "$MODELS_DIR/$f" ]; then
    echo "ERROR: missing or empty $MODELS_DIR/$f -- registry download may have failed" >&2
    ls -la "$MODELS_DIR/" || true
    exit 1
  fi
  cp "$MODELS_DIR/$f" "$TEST_ASSETS_DIR/"
done

echo "[$(basename "$0")] Staged GGUFs in $TEST_ASSETS_DIR/:"
ls -lh "$TEST_ASSETS_DIR/"

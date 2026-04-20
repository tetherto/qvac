#!/bin/bash
set -euo pipefail

# Downloads BCI models and test fixtures from the GitHub release.
# Requires: gh (GitHub CLI) authenticated with repo access.
#
# Usage:
#   bash scripts/download-models.sh           # download models + fixtures
#   bash scripts/download-models.sh --models  # models only
#   bash scripts/download-models.sh --fixtures # fixtures only

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
MODELS_DIR="${PACKAGE_DIR}/models"
FIXTURES_DIR="${PACKAGE_DIR}/test/fixtures"
RELEASE_TAG="bci-test-assets-v0.1.0"
RELEASE_REPO="sharmaraju352/qvac"

download_models() {
  mkdir -p "$MODELS_DIR"

  echo "Downloading BCI model files..."
  gh release download "$RELEASE_TAG" \
    --repo "$RELEASE_REPO" \
    --pattern "ggml-bci-windowed.bin" --dir "$MODELS_DIR" \
    --clobber

  gh release download "$RELEASE_TAG" \
    --repo "$RELEASE_REPO" \
    --pattern "bci-embedder.bin" --dir "$MODELS_DIR" \
    --clobber

  echo "Model files:" && ls -lh "$MODELS_DIR"/*.bin
}

download_fixtures() {
  mkdir -p "$FIXTURES_DIR"

  echo "Downloading BCI test fixtures..."
  gh release download "$RELEASE_TAG" \
    --repo "$RELEASE_REPO" \
    --pattern "bci-test-fixtures.tar.gz" --dir /tmp \
    --clobber

  tar xzf /tmp/bci-test-fixtures.tar.gz -C "$FIXTURES_DIR/"
  rm -f /tmp/bci-test-fixtures.tar.gz

  echo "Test fixtures:" && ls -lh "$FIXTURES_DIR"/*.bin
}

case "${1:-all}" in
  --models)  download_models ;;
  --fixtures) download_fixtures ;;
  all|*)     download_models; echo; download_fixtures ;;
esac

echo ""
echo "Done. Run tests with: npm run test:integration"

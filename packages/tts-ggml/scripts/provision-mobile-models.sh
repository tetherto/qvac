#!/usr/bin/env bash
set -euo pipefail

# provision-mobile-models.sh
#
# Provisions the Supertonic English q4_0 GGUF (~125 MiB) into
# test/mobile/testAssets/ so the mobile test framework can bundle it
# into the test app.  Chatterbox GGUFs are intentionally NOT staged
# (s3gen exceeds Metro's 0x1fffffe8 ~= 512 MiB per-asset string-read
# limit; mobile Chatterbox tests degrade cleanly to a passing skip).
#
# Called from .github/workflows/integration-mobile-test-tts-ggml.yml
# in a step gated by the actions/cache hit — cache miss runs this,
# cache hit skips it (the GGUF is already cached at models/).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADDON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ADDON_DIR"

echo "[$(basename "$0")] Setting up Python venv..."
bash scripts/setup-venv.sh

echo "[$(basename "$0")] Converting Supertonic English (q4_0 -> f16)..."
bash scripts/convert-models.sh -t supertonic-en -q q4_0

echo "[$(basename "$0")] Converted GGUF:"
ls -lh models/

mkdir -p test/mobile/testAssets
for f in supertonic.gguf; do
  if [ ! -s "models/$f" ]; then
    echo "ERROR: missing or empty models/$f -- conversion may have failed" >&2
    ls -la models/ || true
    exit 1
  fi
  cp "models/$f" "test/mobile/testAssets/"
done

echo "[$(basename "$0")] Staged GGUFs in test/mobile/testAssets/:"
ls -lh test/mobile/testAssets/

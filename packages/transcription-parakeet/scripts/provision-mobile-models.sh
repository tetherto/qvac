#!/usr/bin/env bash
set -euo pipefail

# provision-mobile-models.sh
#
# Provisions the Parakeet q4_0 GGUFs (TDT + EOU + Sortformer +
# Sortformer-Streaming v2.1, ~570 MiB total) into test/mobile/testAssets/
# so the mobile test framework can bundle them into the test app.
# CTC is intentionally skipped — shares the FastConformer encoder with
# TDT so duplicating it would only add bundle size.
#
# Called from .github/workflows/integration-mobile-test-transcription-parakeet.yml
# in a step gated by the actions/cache hit — cache miss runs this,
# cache hit skips it (the GGUFs + .nemo checkpoints are cached at models/).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADDON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ADDON_DIR"

echo "[$(basename "$0")] Setting up Python venv..."
bash scripts/setup-venv.sh

for t in tdt eou sortformer sortformer-streaming-v2.1; do
  echo ""
  echo "[$(basename "$0")] === Downloading and converting ${t} ==="
  bash scripts/download-models.sh -t "$t"
  bash scripts/convert-nemo.sh -t "$t" -q q4_0
done

echo ""
echo "[$(basename "$0")] Converted GGUFs:"
ls -lh models/*.q4_0.gguf

mkdir -p test/mobile/testAssets
for f in parakeet-tdt-0.6b-v3.q4_0.gguf \
         parakeet-eou-120m-v1.q4_0.gguf \
         sortformer-4spk-v1.q4_0.gguf \
         diar_streaming_sortformer_4spk-v2.1.q4_0.gguf; do
  if [ ! -s "models/$f" ]; then
    echo "ERROR: missing or empty models/$f -- conversion may have failed" >&2
    ls -la models/ || true
    exit 1
  fi
  cp "models/$f" "test/mobile/testAssets/"
done

echo "[$(basename "$0")] Staged GGUFs in test/mobile/testAssets/:"
ls -lh test/mobile/testAssets/

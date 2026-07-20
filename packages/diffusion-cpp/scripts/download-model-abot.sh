#!/usr/bin/env bash
# Fetch the ABot-World-0-5B-LF model set from corp S3 into a local dir.
# Requires AWS credentials (the diffusion integration workflow configures these
# via OIDC; locally use your own profile). Bucket = MODEL_S3_BUCKET (tether-ai-dev).
#
#   OUT=test/model/abot MODEL_S3_BUCKET=tether-ai-dev bash scripts/download-model-abot.sh
set -euo pipefail

OUT="${OUT:-test/model/abot}"
BUCKET="${MODEL_S3_BUCKET:-tether-ai-dev}"
PREFIX="s3://${BUCKET}/qvac_models_compiled/ABot-World-0-5B-LF/2026-07-17"

mkdir -p "$OUT"
for f in \
  abot-world-0-5b-lf-dit-q8_0.gguf \
  abot-world-0-5b-lf-dit-f16.gguf \
  wan2.2_vae_f16.gguf \
  taew2_2_f16.gguf \
  SHA256SUMS; do
  if [ ! -f "$OUT/$f" ]; then
    echo "downloading $f ..."
    aws s3 cp "$PREFIX/$f" "$OUT/$f"
  fi
done

# integrity check if sha256sum + SHA256SUMS are available
if command -v sha256sum >/dev/null 2>&1 && [ -f "$OUT/SHA256SUMS" ]; then
  ( cd "$OUT" && sha256sum -c SHA256SUMS ) || {
    echo "WARNING: SHA256 verification failed"; exit 1; }
fi
echo "ABot model set ready in $OUT"

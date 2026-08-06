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
# The validated working set (Q8 DiT; the F16 DiT is not used by tests or the
# demo — fetch it explicitly with ABOT_FETCH_F16=1 if you need it for parity
# work).
FILES=(
  abot-world-0-5b-lf-dit-q8_0.gguf
  wan2.2_vae_f16.gguf
  taew2_2_f16.gguf
  SHA256SUMS
)
if [ "${ABOT_FETCH_F16:-0}" = "1" ]; then
  FILES+=(abot-world-0-5b-lf-dit-f16.gguf)
fi
for f in "${FILES[@]}"; do
  if [ ! -f "$OUT/$f" ]; then
    echo "downloading $f ..."
    aws s3 cp "$PREFIX/$f" "$OUT/$f"
  fi
done

# Optional set members: the scene pack (walk lane no-ops without it) and the
# umT5 encoder (scene creation falls back to the manifest safetensors).
# Tolerate absence so the core set keeps working against older uploads.
for f in scene.safetensors umt5-xxl-enc-q8_0.gguf; do
  if [ ! -f "$OUT/$f" ]; then
    aws s3 cp "$PREFIX/$f" "$OUT/$f" || \
      echo "NOTE: $f not on S3 (yet) -- the dependent lane degrades gracefully"
  fi
done

# integrity check if sha256sum + SHA256SUMS are available (--ignore-missing:
# optional set members may be listed in SHA256SUMS but not downloaded)
if command -v sha256sum >/dev/null 2>&1 && [ -f "$OUT/SHA256SUMS" ]; then
  ( cd "$OUT" && sha256sum --check --ignore-missing SHA256SUMS ) || {
    echo "WARNING: SHA256 verification failed"; exit 1; }
fi
echo "ABot model set ready in $OUT"

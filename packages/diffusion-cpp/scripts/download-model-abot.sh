#!/usr/bin/env bash
# Fetch the ABot-World-0-5B-LF model set from the QVAC P2P model registry.
# Public: no credentials needed - @qvac/registry-client joins the swarm with
# its built-in discovery key and streams the blobs from peers (~13.3 GB).
#
#   OUT=test/model/abot bash scripts/download-model-abot.sh
#
# OUT defaults to the integration-test model dir; point it anywhere (e.g.
# ~/abot-models for the demo server's ABOT_MODELS_DIR).
set -euo pipefail

OUT="${OUT:-test/model/abot}"
PREFIX="qvac_models_compiled/ABot-World-0-5B-LF/2026-07-17"

mkdir -p "$OUT"
for f in \
  abot-world-0-5b-lf-dit-q8_0.gguf \
  taew2_2_f16.gguf \
  umt5-xxl-enc-q8_0.gguf \
  wan2.2_vae_f16.gguf; do
  if [ ! -f "$OUT/$f" ]; then
    echo "downloading $f from the P2P registry ..."
    # 's3' is the registry's source label for this entry set (a key
    # namespace in the public registry protocol, not a storage URL).
    npx -y -p @qvac/registry-client qvac-registry download "$PREFIX/$f" s3 -o "$OUT/$f"
  fi
done
echo "ABot model set ready in $OUT"

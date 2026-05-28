#!/bin/bash
set -e

# Emit a public HuggingFace URL for the pi05_base q_aggressive GGUF.
# Same shape llm-llamacpp + diffusion-cpp use for their mobile tests:
# HF runs a global CDN, so AWS Device Farm in us-west-2 hits a nearby
# edge and downloads at native ~10 MB/s instead of the cross-region
# eu-central-1 → us-west-2 path (which was capped at ~0.5–3 MB/s and
# causing the wdio polling timeouts in the mobile workflow).
#
# Apache-2.0 weights → quantised GGUF is a derivative work that's
# explicitly allowed to mirror. Public on purpose so HF's CDN serves it.

# Override with PI05_HF_REPO to point at a project-owned mirror when available.
HF_REPO="${PI05_HF_REPO:-olyas/vla-ggml-models}"
# Pin to a specific HF commit so the mobile GGUF can't drift independently
# of the desktop parity oracle (which is pinned to s3://.../pi05-base/2026-05-21/
# in integration-test-vla.yml and integration-mobile-test-vla.yml). Bump this
# SHA + the S3 oracle date together when re-quantising or re-dumping.
HF_REVISION="${PI05_HF_REVISION:-44e56dc4e668efa9a90ed782a9e2a543d5a67385}"
MODEL_NAME="pi05-base-q-aggressive.gguf"
MODEL_URL="https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${MODEL_NAME}"

echo "🔑 Using HuggingFace CDN for pi05 model..."

# Resolve the actual blob size via HEAD. HF returns an X-Linked-Size
# header for LFS-tracked blobs (the GGUF lives in LFS storage); fall
# back to Content-Length otherwise. -L follows the 302 redirect to the
# cas-bridge.xethub.hf.co backing host.
MODEL_SIZE=$(curl -sLI "$MODEL_URL" \
  | grep -iE "^(x-linked-size|content-length):" \
  | tail -1 \
  | awk '{print $2}' \
  | tr -d '\r')

# HF exposes the LFS blob's git-lfs sha256 as X-Linked-ETag (quoted
# hex). When present, surface it so the mobile downloader can verify.
MODEL_SHA256=$(curl -sLI "$MODEL_URL" \
  | grep -iE "^x-linked-etag:" \
  | tail -1 \
  | awk '{print $2}' \
  | tr -d '"\r')

echo "   ✅ ${MODEL_NAME}"
echo "   URL: ${MODEL_URL}"
if [ -n "$MODEL_SIZE" ]; then echo "   size=${MODEL_SIZE} bytes"; fi
if [ -n "$MODEL_SHA256" ]; then echo "   sha256=${MODEL_SHA256:0:12}…"; fi

if [ -n "$GITHUB_ENV" ]; then
  echo "PI05_MODEL_URL=${MODEL_URL}" >> "$GITHUB_ENV"
  echo "PI05_MODEL_SIZE=${MODEL_SIZE}" >> "$GITHUB_ENV"
  echo "PI05_MODEL_SHA256=${MODEL_SHA256}" >> "$GITHUB_ENV"
  echo "✅ URL exported to GITHUB_ENV"
else
  echo ""
  echo "📋 Export these environment variables:"
  echo "export PI05_MODEL_URL=\"${MODEL_URL}\""
  echo "export PI05_MODEL_SIZE=\"${MODEL_SIZE}\""
  echo "export PI05_MODEL_SHA256=\"${MODEL_SHA256}\""
fi

echo ""
echo "🎉 Ready to run mobile tests with pi05 model!"

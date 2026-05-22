#!/bin/bash
set -e

# Emit a public HuggingFace URL for the SmolVLA LIBERO GGUF. Same
# rationale as generate-pi05-presigned-url.sh — HF's global CDN is the
# proven path for the mobile workflow (llm-llamacpp + diffusion-cpp
# both pull their 2–5 GB models from HF for the exact same reason).

HF_REPO="${SMOLVLA_HF_REPO:-olyas/vla-ggml-models}"
MODEL_NAME="smolvla-libero-vision-q8.gguf"
MODEL_URL="https://huggingface.co/${HF_REPO}/resolve/main/${MODEL_NAME}"

echo "🔑 Using HuggingFace CDN for SmolVLA model..."

MODEL_SIZE=$(curl -sLI "$MODEL_URL" \
  | grep -iE "^(x-linked-size|content-length):" \
  | tail -1 \
  | awk '{print $2}' \
  | tr -d '\r')

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
  echo "SMOLVLA_MODEL_URL=${MODEL_URL}" >> "$GITHUB_ENV"
  echo "SMOLVLA_MODEL_SIZE=${MODEL_SIZE}" >> "$GITHUB_ENV"
  echo "SMOLVLA_MODEL_SHA256=${MODEL_SHA256}" >> "$GITHUB_ENV"
  echo "✅ URL exported to GITHUB_ENV"
else
  echo ""
  echo "📋 Export these environment variables:"
  echo "export SMOLVLA_MODEL_URL=\"${MODEL_URL}\""
  echo "export SMOLVLA_MODEL_SIZE=\"${MODEL_SIZE}\""
  echo "export SMOLVLA_MODEL_SHA256=\"${MODEL_SHA256}\""
fi

echo ""
echo "🎉 Ready to run mobile tests with SmolVLA model!"

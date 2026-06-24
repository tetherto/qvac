#!/bin/bash
set -e

# Generate a presigned URL for the SmolVLA LIBERO model hosted in S3 so that
# the mobile test-addon-mobile app can download it at runtime on AWS Device
# Farm. Matches the pattern used by generate-indictrans-presigned-urls.sh.

REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${S3_BUCKET:-${MODEL_S3_BUCKET}}"
BASE_PATH="qvac_models_compiled/vla/smolvla-libero"
MODEL_NAME="smolvla-libero-vision-q8.gguf"

# Mask the bucket name in workflow logs before any command can echo it.
# When run outside GitHub Actions ($GITHUB_ACTIONS unset) this is a no-op
# echo that the runner ignores.
if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "$BUCKET" ]; then
    echo "::add-mask::${BUCKET}"
fi

echo "🔑 Generating presigned URL for SmolVLA LIBERO model..."
echo "   Region: $REGION"

# Find the latest date directory so we track new uploads without editing this
# script each time a new model drops. Bucket name and full s3:// paths are
# kept out of the log so they don't leak via public CI output.
echo "🔍 Looking for date directories..."
DATE_DIRS=$(aws s3 ls "s3://${BUCKET}/${BASE_PATH}/" --region "$REGION" 2>/dev/null | grep "PRE" | awk '{print $2}' | sed 's/\///')

if [ -z "$DATE_DIRS" ]; then
    echo "❌ No date directories found under base path"
    exit 1
fi

LATEST_DATE=$(echo "$DATE_DIRS" | sort | tail -1)
echo "   Using date: $LATEST_DATE"

MODEL_KEY="${BASE_PATH}/${LATEST_DATE}/${MODEL_NAME}"

# Verify model exists
echo "🔍 Verifying model exists..."
HEAD_JSON=$(aws s3api head-object --bucket "$BUCKET" --key "$MODEL_KEY" --region "$REGION" 2>/dev/null || true)
if [ -z "$HEAD_JSON" ]; then
    echo "❌ Model not found at expected key"
    exit 1
fi

# Capture ContentLength so the test runner can verify the cached download
# matches the publisher's expected size exactly (instead of a >= 100MB
# floor that lets a partial download masquerade as a complete one).
MODEL_SIZE=$(echo "$HEAD_JSON" | jq -r '.ContentLength // empty')

# Look for a sibling .sha256 sidecar (single-line: "<hex>  filename" or
# just "<hex>"). When present it lets the test harness do a full content
# check; when absent we fall back to size-only verification.
MODEL_SHA256=""
SHA256_KEY="${MODEL_KEY}.sha256"
if aws s3api head-object --bucket "$BUCKET" --key "$SHA256_KEY" --region "$REGION" > /dev/null 2>&1; then
    SHA_TMP=$(mktemp)
    if aws s3 cp "s3://${BUCKET}/${SHA256_KEY}" "$SHA_TMP" --region "$REGION" --quiet; then
        MODEL_SHA256=$(awk '{print $1}' "$SHA_TMP" | head -1 | tr -d '[:space:]')
    fi
    rm -f "$SHA_TMP"
fi

# The model is ~1-4GB, the mobile build+upload+schedule window can easily
# push past an hour, so use a 6h expiry.
echo "📝 Generating presigned URL (valid for 6 hours)..."
MODEL_URL=$(aws s3 presign "s3://${BUCKET}/${MODEL_KEY}" --expires-in 21600 --region "$REGION")

if [ -z "$MODEL_URL" ]; then
    echo "❌ Failed to generate presigned URL"
    exit 1
fi

echo "   ✅ ${MODEL_NAME}"
if [ -n "$MODEL_SIZE" ]; then echo "   size=${MODEL_SIZE} bytes"; fi
if [ -n "$MODEL_SHA256" ]; then echo "   sha256 sidecar found"; fi

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

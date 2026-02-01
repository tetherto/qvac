#!/bin/bash
set -e

# Configuration
REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${S3_BUCKET:-tether-ai-dev}"
BASE_PATH="qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-en-indic-dist-200M"
MODEL_NAME="ggml-indictrans2-en-indic-dist-200M-q4_0.bin"

echo "🔑 Generating presigned URL for IndicTrans model..."
echo "   Region: $REGION"
echo "   Bucket: $BUCKET"

# Find the latest date directory
echo "🔍 Looking for date directories..."
DATE_DIRS=$(aws s3 ls "s3://${BUCKET}/${BASE_PATH}/" --region "$REGION" 2>/dev/null | grep "PRE" | awk '{print $2}' | sed 's/\///')

if [ -z "$DATE_DIRS" ]; then
    echo "❌ No date directories found in s3://${BUCKET}/${BASE_PATH}/"
    exit 1
fi

# Get the latest date (sort and take the last one)
LATEST_DATE=$(echo "$DATE_DIRS" | sort | tail -1)
echo "   Using date: $LATEST_DATE"

MODEL_KEY="${BASE_PATH}/${LATEST_DATE}/${MODEL_NAME}"
echo "   Model: s3://${BUCKET}/${MODEL_KEY}"

# Verify model exists
echo "🔍 Verifying model exists..."
if ! aws s3 ls "s3://${BUCKET}/${MODEL_KEY}" --region "$REGION" > /dev/null 2>&1; then
    echo "❌ Model not found: s3://${BUCKET}/${MODEL_KEY}"
    exit 1
fi

# Generate presigned URL (valid for 1 hour = 3600 seconds)
echo "📝 Generating presigned URL (valid for 1 hour)..."
MODEL_URL=$(aws s3 presign "s3://${BUCKET}/${MODEL_KEY}" --expires-in 3600 --region "$REGION")

if [ -z "$MODEL_URL" ]; then
    echo "❌ Failed to generate presigned URL"
    exit 1
fi

echo "   ✅ ${MODEL_NAME}"

# Export to GitHub Actions environment (if running in CI)
if [ -n "$GITHUB_ENV" ]; then
    echo "INDICTRANS_MODEL_URL=${MODEL_URL}" >> "$GITHUB_ENV"
    echo "✅ URL exported to GITHUB_ENV"
else
    # For local testing - output export command
    echo ""
    echo "📋 Export this environment variable:"
    echo "export INDICTRANS_MODEL_URL=\"${MODEL_URL}\""
fi

echo ""
echo "🎉 Ready to run mobile tests with IndicTrans model!"


#!/bin/bash

# Script to generate presigned S3 URLs for OCR models using AWS CLI
# Used in CI pipeline to provide temporary access to models for mobile testing
#
# Usage:
#   ./scripts/generate-ocr-presigned-urls.sh
#
# Environment variables used:
#   AWS_ACCESS_KEY_ID - AWS access key
#   AWS_SECRET_ACCESS_KEY - AWS secret key
#   AWS_REGION - AWS region (default: us-east-1)
#
# Output:
#   Creates ocr-model-urls.json for bundling in mobile app

set -e

# Configuration
REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${S3_BUCKET:-tether-ai-dev}"
# Use rec_dyn subdirectory - dynamic width models
BASE_PATH="qvac_models_compiled/ocr/rec_dyn"

echo "🔑 Generating presigned URLs for OCR models..."
echo "   Region: $REGION"
echo "   Bucket: $BUCKET"
echo "   Path: $BASE_PATH"

# Detector
DETECTOR_KEY="${BASE_PATH}/detector_craft.onnx"

echo "🔍 Verifying detector exists..."
if ! aws s3 ls "s3://${BUCKET}/${DETECTOR_KEY}" --region "$REGION" > /dev/null 2>&1; then
    echo "❌ Detector not found: s3://${BUCKET}/${DETECTOR_KEY}"
    exit 1
fi

echo "📝 Generating presigned URL for detector..."
DETECTOR_URL=$(aws s3 presign "s3://${BUCKET}/${DETECTOR_KEY}" --expires-in 3600 --region "$REGION")

if [ -z "$DETECTOR_URL" ]; then
    echo "❌ Failed to generate presigned URL for detector"
    exit 1
fi
echo "   ✅ detector_craft.onnx"

# Latin recognizer (for simple mobile test)
RECOGNIZER_KEY="${BASE_PATH}/recognizer_latin.onnx"

echo "🔍 Verifying recognizer_latin exists..."
if ! aws s3 ls "s3://${BUCKET}/${RECOGNIZER_KEY}" --region "$REGION" > /dev/null 2>&1; then
    echo "❌ Recognizer not found: s3://${BUCKET}/${RECOGNIZER_KEY}"
    exit 1
fi

echo "📝 Generating presigned URL for recognizer_latin..."
RECOGNIZER_URL=$(aws s3 presign "s3://${BUCKET}/${RECOGNIZER_KEY}" --expires-in 3600 --region "$REGION")

if [ -z "$RECOGNIZER_URL" ]; then
    echo "❌ Failed to generate presigned URL for recognizer"
    exit 1
fi
echo "   ✅ recognizer_latin.onnx"

# Write JSON config
OUTPUT_DIR="${OUTPUT_DIR:-.}"
JSON_FILE="${OUTPUT_DIR}/ocr-model-urls.json"

cat > "$JSON_FILE" << EOF
{
  "detectorUrl": "${DETECTOR_URL}",
  "recognizer_latin_url": "${RECOGNIZER_URL}",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "✅ Created ${JSON_FILE}"
cat "$JSON_FILE"

echo ""
echo "🎉 Ready to run mobile tests!"

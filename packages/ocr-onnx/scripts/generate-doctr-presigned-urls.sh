#!/bin/bash

# Script to generate presigned S3 URLs for DocTR models using AWS CLI
# Used in CI pipeline to provide temporary access to models for mobile testing
#
# Usage:
#   ./scripts/generate-doctr-presigned-urls.sh
#
# Environment variables used:
#   AWS_ACCESS_KEY_ID - AWS access key
#   AWS_SECRET_ACCESS_KEY - AWS secret key
#   AWS_REGION - AWS region (default: eu-central-1)
#   MODEL_S3_BUCKET - S3 bucket name
#
# Output:
#   Creates doctr-model-urls.json for bundling in mobile app

set -e

# Configuration
REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${S3_BUCKET:-${MODEL_S3_BUCKET}}"
BASE_PATH="qvac_models_compiled/ocr/doctr"

if [ -z "$BUCKET" ]; then
  echo "❌ S3 bucket not set. Set S3_BUCKET or MODEL_S3_BUCKET environment variable."
  exit 1
fi

echo "🔑 Generating presigned URLs for DocTR models..."
echo "   Region: $REGION"
echo "   Bucket: $BUCKET"
echo "   Path: $BASE_PATH"

generate_url() {
  local model_name="$1"
  local s3_key="${BASE_PATH}/${model_name}"

  echo "🔍 Verifying ${model_name} exists..." >&2
  if ! aws s3 ls "s3://${BUCKET}/${s3_key}" --region "$REGION" > /dev/null 2>&1; then
    echo "❌ Model not found: s3://${BUCKET}/${s3_key}" >&2
    exit 1
  fi

  echo "📝 Generating presigned URL for ${model_name}..." >&2
  local url
  url=$(aws s3 presign "s3://${BUCKET}/${s3_key}" --expires-in 3600 --region "$REGION")

  if [ -z "$url" ]; then
    echo "❌ Failed to generate presigned URL for ${model_name}" >&2
    exit 1
  fi

  echo "   ✅ ${model_name}" >&2
  echo "$url"
}

DB_RESNET50_URL=$(generate_url "db_resnet50.onnx")
PARSEQ_URL=$(generate_url "parseq.onnx")
DB_MOBILENET_URL=$(generate_url "db_mobilenet_v3_large.onnx")
CRNN_MOBILENET_URL=$(generate_url "crnn_mobilenet_v3_small.onnx")

# Write JSON config
OUTPUT_DIR="${OUTPUT_DIR:-.}"
JSON_FILE="${OUTPUT_DIR}/doctr-model-urls.json"

GENERATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg db_resnet50 "$DB_RESNET50_URL" \
  --arg parseq "$PARSEQ_URL" \
  --arg db_mobilenet "$DB_MOBILENET_URL" \
  --arg crnn_mobilenet "$CRNN_MOBILENET_URL" \
  --arg ts "$GENERATED_AT" \
  '{
    "db_resnet50.onnx": $db_resnet50,
    "parseq.onnx": $parseq,
    "db_mobilenet_v3_large.onnx": $db_mobilenet,
    "crnn_mobilenet_v3_small.onnx": $crnn_mobilenet,
    "generatedAt": $ts
  }' > "$JSON_FILE"

echo ""
echo "✅ Created ${JSON_FILE}"

echo ""
echo "🎉 DocTR model URLs ready for mobile tests!"

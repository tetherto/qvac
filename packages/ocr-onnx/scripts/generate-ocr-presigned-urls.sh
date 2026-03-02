#!/bin/bash

# Script to generate presigned S3 URLs for OCR models using AWS CLI
# Used in CI pipeline to provide temporary access to models for mobile testing.
# Generates URLs for detector + all recognizers so mobile OCR tests (basic and
# full suite) can download the same set of models as desktop integration tests.
#
# Usage:
#   ./scripts/generate-ocr-presigned-urls.sh
#
# Environment variables used:
#   AWS_ACCESS_KEY_ID - AWS access key
#   AWS_SECRET_ACCESS_KEY - AWS secret key
#   AWS_REGION - AWS region (default: eu-central-1)
#   OUTPUT_DIR - Directory for ocr-model-urls.json (default: .)
#
# Output:
#   Creates ocr-model-urls.json for bundling in mobile app (detectorUrl +
#   recognizer_<name>_url for each recognizer).

set -e

# Configuration
REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${S3_BUCKET:-${MODEL_S3_BUCKET}}"
# Use rec_dyn subdirectory - dynamic width models (same as desktop integration)
BASE_PATH="qvac_models_compiled/ocr/rec_dyn"

# Recognizers aligned with full-ocr-suite and download-ocr-models.js
RECOGNIZERS=(latin korean arabic cyrillic devanagari bengali thai zh_sim zh_tra japanese tamil telugu kannada)

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

# Generate presigned URL for one recognizer; echo the URL
gen_recognizer_url() {
    local name="$1"
    local key="${BASE_PATH}/recognizer_${name}.onnx"
    if ! aws s3 ls "s3://${BUCKET}/${key}" --region "$REGION" > /dev/null 2>&1; then
        echo "❌ Recognizer not found: s3://${BUCKET}/${key}" >&2
        exit 1
    fi
    aws s3 presign "s3://${BUCKET}/${key}" --expires-in 3600 --region "$REGION"
}

# Build JSON: detectorUrl + recognizer_<name>_url for each
OUTPUT_DIR="${OUTPUT_DIR:-.}"
JSON_FILE="${OUTPUT_DIR}/ocr-model-urls.json"

# Start JSON (detectorUrl first, then all recognizers, then generatedAt)
printf '{\n  "detectorUrl": "%s",\n' "${DETECTOR_URL//\"/\\\"}" > "$JSON_FILE"
for name in "${RECOGNIZERS[@]}"; do
    echo "📝 Generating presigned URL for recognizer_${name}..."
    url=$(gen_recognizer_url "$name")
    echo "   ✅ recognizer_${name}.onnx"
    key="recognizer_${name}_url"
    url_escaped="${url//\"/\\\"}"
    printf '  "%s": "%s",\n' "$key" "$url_escaped" >> "$JSON_FILE"
done
printf '  "generatedAt": "%s"\n}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$JSON_FILE"

echo ""
echo "✅ Created ${JSON_FILE}"
cat "$JSON_FILE"

echo ""
echo "🎉 Ready to run mobile tests (detector + all recognizers)."

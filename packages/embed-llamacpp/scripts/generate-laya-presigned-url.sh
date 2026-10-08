#!/bin/bash
# Generate a presigned S3 URL for the Laya GGUF used by the mobile integration
# tests (test/integration/laya.test.js). Laya has no Hugging Face source, so it
# is not in models.manifest.json and the manifest seed/presign step does not
# cover it; the Device Farm host pre-stages it from this URL instead
# (scripts/generate-prestage-block.js, PRESTAGE_S3_MODELS).
#
# Usage:
#   ./scripts/generate-laya-presigned-url.sh
#
# Environment variables:
#   MODEL_S3_BUCKET       - S3 bucket name (required)
#   AWS_REGION            - AWS region (default: eu-central-1)
#   LAYA_S3_PREFIX        - S3 prefix of the Laya GGUFs
#                           (default: qvac_models_compiled/ggml/laya/2026-10-01)
#   OUTPUT_DIR            - Directory to write laya-model-urls.json (default: .)
#   MODEL_URL_EXPIRES_IN  - Presigned-URL lifetime in seconds (default: 21600 =
#                           6h). In CI the effective lifetime is capped by the
#                           OIDC session (role-duration-seconds), as in
#                           ocr-ggml's generate-ocr-ggml-presigned-urls.sh.
#
# Output:
#   Creates laya-model-urls.json mapping the GGUF file name to its presigned
#   URL, the shape generate-prestage-block.js reads from PRESTAGE_S3_MODELS.

set -e

REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${MODEL_S3_BUCKET}"
LAYA_PREFIX="${LAYA_S3_PREFIX:-qvac_models_compiled/ggml/laya/2026-10-01}"
OUTPUT_DIR="${OUTPUT_DIR:-.}"
JSON_FILE="${OUTPUT_DIR}/laya-model-urls.json"
EXPIRES_IN="${MODEL_URL_EXPIRES_IN:-21600}"
MODEL_NAME="laya-multilingual-Q8_0.gguf"

if [ -z "$BUCKET" ]; then
  echo "ERROR: MODEL_S3_BUCKET is not set."
  exit 1
fi

echo "Generating presigned URL for the Laya GGUF..."
echo "  Region: $REGION"
echo "  Prefix: $LAYA_PREFIX"

KEY="${LAYA_PREFIX}/${MODEL_NAME}"
if ! aws s3 ls "s3://${BUCKET}/${KEY}" --region "$REGION" > /dev/null 2>&1; then
  echo "ERROR: s3://${BUCKET}/${KEY} not found" >&2
  exit 1
fi
URL=$(aws s3 presign "s3://${BUCKET}/${KEY}" --expires-in "$EXPIRES_IN" --region "$REGION")

mkdir -p "$OUTPUT_DIR"
printf '{\n  "%s": "%s"\n}\n' "$MODEL_NAME" "${URL//\"/\\\"}" > "$JSON_FILE"

echo ""
echo "Created ${JSON_FILE}"
# Do NOT print the file contents: the presigned URL is a bearer URL whose
# query-string signature would otherwise leak into CI logs.
echo "  object: ${KEY}"

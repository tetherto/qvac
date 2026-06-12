#!/bin/bash

# Generate presigned S3 URLs for GGUF OCR models used by mobile integration tests.
# On-device the tests download models at runtime from these URLs instead of having
# them bundled in the app (which would make the APK/IPA impractically large).
#
# Usage:
#   ./scripts/generate-ocr-ggml-presigned-urls.sh
#
# Environment variables:
#   MODEL_S3_BUCKET             - S3 bucket name (required)
#   AWS_REGION                  - AWS region (default: eu-central-1)
#   EASYOCR_S3_PREFIX           - S3 prefix for EasyOCR models
#                                 (default: qvac_models_compiled/ocr/gguf/easyocr/2026-05-14)
#   DOCTR_S3_PREFIX             - S3 prefix for DocTR models
#                                 (default: qvac_models_compiled/ocr/gguf/doctrf16/2026-05-15)
#   OUTPUT_DIR                  - Directory to write ocr-ggml-model-urls.json (default: .)
#   MODEL_URL_EXPIRES_IN        - Presigned-URL lifetime in seconds
#                                 (default: 21600 = 6h). Must exceed the time
#                                 between URL generation and the on-device
#                                 download (build + upload + device-farm queue +
#                                 sequential per-group runs), or S3 returns
#                                 HTTP 403 (expired signature) mid-suite.
#
# Output:
#   Creates ocr-ggml-model-urls.json with presigned URLs keyed by <model_stem>_url.
#   Keys: craft_mlt_25k_url, latin_g2_url, db_mobilenet_v3_large_url,
#         crnn_mobilenet_v3_small_url, generatedAt.

set -e

REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${MODEL_S3_BUCKET}"
EASYOCR_PREFIX="${EASYOCR_S3_PREFIX:-qvac_models_compiled/ocr/gguf/easyocr/2026-05-14}"
DOCTR_PREFIX="${DOCTR_S3_PREFIX:-qvac_models_compiled/ocr/gguf/doctrf16/2026-05-15}"
OUTPUT_DIR="${OUTPUT_DIR:-.}"
JSON_FILE="${OUTPUT_DIR}/ocr-ggml-model-urls.json"

# Presigned URLs are generated early (build/upload phase) but devices fetch the
# models much later — after build, upload, device-farm queue, and sequential
# per-group runs. The previous 1h TTL expired before long-queued devices reached
# the download step, causing HTTP 403 and a failed mobile run. 6h covers the
# worst-case run (full iOS matrix ~2h plus queueing) with margin, while keeping
# the bearer-URL exposure window as short as practical.
EXPIRES_IN="${MODEL_URL_EXPIRES_IN:-21600}"

if [ -z "$BUCKET" ]; then
  echo "ERROR: MODEL_S3_BUCKET is not set."
  exit 1
fi

echo "Generating presigned URLs for GGUF OCR models..."
echo "  Region: $REGION"
echo "  EasyOCR prefix: $EASYOCR_PREFIX"
echo "  DocTR prefix:   $DOCTR_PREFIX"

gen_url() {
  local key="$1"
  if ! aws s3 ls "s3://${BUCKET}/${key}" --region "$REGION" > /dev/null 2>&1; then
    echo "ERROR: s3://${BUCKET}/${key} not found" >&2
    exit 1
  fi
  aws s3 presign "s3://${BUCKET}/${key}" --expires-in "$EXPIRES_IN" --region "$REGION"
}

CRAFT_URL=$(gen_url "${EASYOCR_PREFIX}/craft_mlt_25k.gguf")
echo "  craft_mlt_25k.gguf"
LATIN_URL=$(gen_url "${EASYOCR_PREFIX}/latin_g2.gguf")
echo "  latin_g2.gguf"
DB_URL=$(gen_url "${DOCTR_PREFIX}/db_mobilenet_v3_large.gguf")
echo "  db_mobilenet_v3_large.gguf"
CRNN_URL=$(gen_url "${DOCTR_PREFIX}/crnn_mobilenet_v3_small.gguf")
echo "  crnn_mobilenet_v3_small.gguf"

mkdir -p "$OUTPUT_DIR"
printf '{\n' > "$JSON_FILE"
printf '  "craft_mlt_25k_url": "%s",\n' "${CRAFT_URL//\"/\\\"}" >> "$JSON_FILE"
printf '  "latin_g2_url": "%s",\n' "${LATIN_URL//\"/\\\"}" >> "$JSON_FILE"
printf '  "db_mobilenet_v3_large_url": "%s",\n' "${DB_URL//\"/\\\"}" >> "$JSON_FILE"
printf '  "crnn_mobilenet_v3_small_url": "%s",\n' "${CRNN_URL//\"/\\\"}" >> "$JSON_FILE"
printf '  "generatedAt": "%s"\n}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$JSON_FILE"

echo ""
echo "Created ${JSON_FILE}"
# Do NOT print the file contents: it holds presigned bearer URLs (valid for
# ${EXPIRES_IN}s) whose query-string signatures would otherwise leak into CI
# logs. Log only the JSON keys and object paths — never the signed URLs.
echo "  keys: craft_mlt_25k_url, latin_g2_url, db_mobilenet_v3_large_url, crnn_mobilenet_v3_small_url"
echo "  objects:"
echo "    ${EASYOCR_PREFIX}/craft_mlt_25k.gguf"
echo "    ${EASYOCR_PREFIX}/latin_g2.gguf"
echo "    ${DOCTR_PREFIX}/db_mobilenet_v3_large.gguf"
echo "    ${DOCTR_PREFIX}/crnn_mobilenet_v3_small.gguf"

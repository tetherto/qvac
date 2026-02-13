#!/bin/bash
#
# Download Parakeet TDT model from S3:
#   s3://tether-ai-dev/qvac_models_compiled/parakeet/
#
# Usage:
#   ./scripts/download-models-s3.sh --access-key <KEY> --secret-key <SECRET> [--model fp32|int8] [--dry-run]
#
set -euo pipefail

MODELS_DIR="./models"
S3_BASE="s3://tether-ai-dev/qvac_models_compiled/parakeet"
MODEL_VARIANT="int8"  # Default to INT8 (smaller, recommended)
DRY_RUN=0
AWS_ACCESS_KEY=""
AWS_SECRET_KEY=""
AWS_REGION=""

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --access-key KEY     AWS access key ID (required).
  --secret-key SECRET  AWS secret access key (required).
  --model VARIANT      Model variant to download (default: int8).
                         fp32         - Full precision model (~2.4 GB)
                         int8         - INT8 full quantized (~650 MB, recommended)
                         int8-partial - INT8 partial quantized (~890 MB)
  --region REGION      AWS region to use.
  --dry-run            Show what would be downloaded, but don't download.
  --models-dir DIR     Models directory to download to (default: ./models).
  -h, --help           Show this help text.

Examples:
  # Download INT8 full model (default, recommended)
  $0 --access-key <KEY> --secret-key <SECRET>

  # Download FP32 model (full precision)
  $0 --access-key <KEY> --secret-key <SECRET> --model fp32

  # Download INT8 partial model (MatMul-only quantization)
  $0 --access-key <KEY> --secret-key <SECRET> --model int8-partial

Notes:
  - INT8 full quantizes Conv+MatMul layers (~73% smaller than FP32).
  - INT8 partial quantizes MatMul layers only (~63% smaller than FP32).
  - FP32 model may provide slightly better accuracy for some languages.
  - Requires: aws cli installed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --access-key) AWS_ACCESS_KEY="${2:-}"; shift 2 ;;
    --secret-key) AWS_SECRET_KEY="${2:-}"; shift 2 ;;
    --model) MODEL_VARIANT="${2:-}"; shift 2 ;;
    --region) AWS_REGION="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --models-dir) MODELS_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws cli not found. Install AWS CLI first." >&2
  exit 1
fi

if [[ -z "$AWS_ACCESS_KEY" ]]; then
  echo "ERROR: --access-key is required." >&2
  usage
  exit 1
fi

if [[ -z "$AWS_SECRET_KEY" ]]; then
  echo "ERROR: --secret-key is required." >&2
  usage
  exit 1
fi

# Determine model paths based on variant
case "$MODEL_VARIANT" in
  fp32)
    MODEL_NAME="parakeet-tdt-0.6b-v3-onnx"
    MODEL_DESC="FP32 (full precision, ~2.4 GB)"
    ;;
  int8)
    MODEL_NAME="parakeet-tdt-0.6b-v3-onnx-int8"
    MODEL_DESC="INT8 full (Conv+MatMul quantized, ~650 MB)"
    ;;
  int8-partial)
    MODEL_NAME="parakeet-tdt-0.6b-v3-onnx-int8-partial"
    MODEL_DESC="INT8 partial (MatMul-only quantized, ~890 MB)"
    ;;
  *)
    echo "ERROR: Unknown model variant '$MODEL_VARIANT'. Use 'fp32', 'int8', or 'int8-partial'." >&2
    exit 1
    ;;
esac

S3_URI="${S3_BASE}/${MODEL_NAME}/"
LOCAL_DEST="${MODELS_DIR}/${MODEL_NAME}/"

# Export AWS credentials
export AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$AWS_SECRET_KEY"

AWS_ARGS=()
if [[ -n "$AWS_REGION" ]]; then AWS_ARGS+=(--region "$AWS_REGION"); fi
if [[ "$DRY_RUN" -eq 1 ]]; then AWS_ARGS+=(--dryrun); fi

echo ""
echo "========================================="
echo "Downloading Parakeet TDT model from S3"
echo "========================================="
echo "Model:  $MODEL_DESC"
echo "Source: $S3_URI"
echo "Dest:   $LOCAL_DEST"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Mode:   DRY RUN (no downloads)"
else
  echo "Mode:   DOWNLOAD"
fi
echo ""

mkdir -p "$LOCAL_DEST"

aws ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} s3 sync "$S3_URI" "$LOCAL_DEST" \
  --exclude "*" \
  --include "*.onnx" \
  --include "*.onnx.data" \
  --include "*.txt"

echo ""
echo "========================================="
echo "Download complete!"
echo "========================================="
echo ""
echo "Model downloaded to: $LOCAL_DEST"
echo ""
echo "You can now run the examples:"
echo "  bare examples/quickstart.js"
echo "  bare examples/transcribe.js --file examples/samples/French.raw"
if [[ "$MODEL_VARIANT" == "int8" || "$MODEL_VARIANT" == "int8-partial" ]]; then
  echo "  bare examples/transcribe.js -f examples/samples/croatian.raw -m models/${MODEL_NAME}"
fi
echo ""

#!/bin/bash
#
# Download fine-tuned Whisper GGML models from S3.
#
# These are custom ggml-converted models maintained by the team.
# Standard Whisper models should be downloaded from HuggingFace using download-models.sh instead.
#
# Usage:
#   MODEL_S3_BUCKET=<bucket> ./scripts/download-models-s3.sh --access-key <KEY> --secret-key <SECRET> [--model <name>] [--dry-run]
#
set -euo pipefail

MODELS_DIR="./models"
S3_BUCKET="${MODEL_S3_BUCKET:-}"
S3_BASE=""
MODEL_NAME=""
DRY_RUN=0
AWS_ACCESS_KEY=""
AWS_SECRET_KEY=""
AWS_REGION=""

usage() {
  cat <<EOF
Usage: $0 [options]

Download fine-tuned Whisper GGML models from S3.

Options:
  --access-key KEY     AWS access key ID (required).
  --secret-key SECRET  AWS secret access key (required).
  --model NAME         Model name to download (required).
                         Examples of fine-tuned models:
                           de-tiny-ggml-model-f16    German (tiny)
                           de-base-ggml-model-f16    German (base)
                           fr-tiny-ggml-model-f16    French (tiny)
                           es-tiny-ggml-model-f16    Spanish (tiny)
                           pt-tiny-ggml-model-f16    Portuguese (tiny)
                           it-tiny-ggml-model-f16    Italian (tiny)
                           ru-tiny-ggml-model-f16    Russian (tiny)
                           ja-tiny-ggml-model-f16    Japanese (tiny)
  --region REGION      AWS region to use.
  --dry-run            Show what would be downloaded, but don't download.
  --models-dir DIR     Models directory to download to (default: ./models).
  -h, --help           Show this help text.

Environment:
  MODEL_S3_BUCKET        S3 bucket name (required).

Examples:
  # Download German fine-tuned tiny model
  MODEL_S3_BUCKET=my-bucket $0 --access-key <KEY> --secret-key <SECRET> --model de-tiny-ggml-model-f16

Notes:
  - Standard Whisper models (ggml-tiny.bin, etc.) should be downloaded from
    HuggingFace using ./scripts/download-models.sh instead.
  - Only use this script for team-maintained fine-tuned ggml conversions.
  - Requires: aws cli installed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --access-key) AWS_ACCESS_KEY="${2:-}"; shift 2 ;;
    --secret-key) AWS_SECRET_KEY="${2:-}"; shift 2 ;;
    --model) MODEL_NAME="${2:-}"; shift 2 ;;
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

if [[ -z "$S3_BUCKET" ]]; then
  echo "ERROR: MODEL_S3_BUCKET environment variable is required." >&2
  exit 1
fi

if [[ -z "$MODEL_NAME" ]]; then
  echo "ERROR: --model is required." >&2
  usage
  exit 1
fi

S3_BASE="s3://${S3_BUCKET}/whisper"
S3_URI="${S3_BASE}/${MODEL_NAME}/"
LOCAL_DEST="${MODELS_DIR}/${MODEL_NAME}/"

export AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$AWS_SECRET_KEY"

AWS_ARGS=()
if [[ -n "$AWS_REGION" ]]; then AWS_ARGS+=(--region "$AWS_REGION"); fi
if [[ "$DRY_RUN" -eq 1 ]]; then AWS_ARGS+=(--dryrun); fi

echo ""
echo "========================================="
echo "Downloading fine-tuned Whisper model from S3"
echo "========================================="
echo "Model:  $MODEL_NAME"
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
  --include "*.bin"

echo ""
echo "========================================="
echo "Download complete!"
echo "========================================="
echo ""
echo "Model downloaded to: $LOCAL_DEST"
echo ""

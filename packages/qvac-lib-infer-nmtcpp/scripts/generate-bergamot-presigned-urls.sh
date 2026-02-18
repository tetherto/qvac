#!/bin/bash

# Script to generate presigned S3 URLs for Bergamot models using AWS CLI
# Used in CI pipeline to provide temporary access to models for mobile testing
# 
# Usage:
#   ./scripts/generate-bergamot-presigned-urls.sh [language-pair]
# 
# Examples:
#   ./scripts/generate-bergamot-presigned-urls.sh enit
#   ./scripts/generate-bergamot-presigned-urls.sh enru
# 
# Environment variables used:
#   AWS_ACCESS_KEY_ID - AWS access key (set by configure-aws-credentials action)
#   AWS_SECRET_ACCESS_KEY - AWS secret key (set by configure-aws-credentials action)
#   AWS_REGION - AWS region (default: eu-central-1)
#   BERGAMOT_LANG_PAIR - Language pair (e.g., 'enit', 'enfr') - can also be passed as argument
# 
# Optional:
#   S3_BUCKET - S3 bucket name (required, or set MODEL_S3_BUCKET)
#   S3_BASE_PATH - Base path for models (default: qvac_models_compiled/bergamot/memory-base)
# 
# Output:
#   Exports BERGAMOT_MODEL_URL and BERGAMOT_VOCAB_URL to GITHUB_ENV

set -e  # Exit on any error

# Get language pair from argument or environment
LANG_PAIR="${1:-$BERGAMOT_LANG_PAIR}"

if [ -z "$LANG_PAIR" ]; then
    echo "❌ No language pair specified!"
    echo "Usage: $0 [language-pair]"
    echo "Example: $0 enit"
    echo "Or set BERGAMOT_LANG_PAIR environment variable"
    exit 1
fi

# Configuration
REGION="${AWS_REGION:-eu-central-1}"
BUCKET="${S3_BUCKET:-${MODEL_S3_BUCKET}}"
BASE_PATH="${S3_BASE_PATH:-qvac_models_compiled/bergamot}"
FOLDER_NAME="bergamot-${LANG_PAIR}"
S3_PREFIX="${BASE_PATH}/${FOLDER_NAME}/"

echo "🔑 Generating presigned URLs for Bergamot models..."
echo "   Region: $REGION"
echo "   Bucket: $BUCKET"
echo "   Language pair: $LANG_PAIR"
echo "   Base path: s3://${BUCKET}/${S3_PREFIX}"

# Find the latest date directory
echo "🔍 Looking for date directories..."
DATE_DIRS=$(aws s3 ls "s3://${BUCKET}/${S3_PREFIX}" --region "$REGION" 2>/dev/null | grep "PRE" | awk '{print $2}' | sed 's/\///')

if [ -z "$DATE_DIRS" ]; then
    echo "❌ No date directories found in s3://${BUCKET}/${S3_PREFIX}"
    echo "Available language pairs:"
    aws s3 ls "s3://${BUCKET}/${BASE_PATH}/" --region "$REGION" | grep "PRE bergamot-" | head -10
    exit 1
fi

# Get the latest date (sort and take the last one)
LATEST_DATE=$(echo "$DATE_DIRS" | sort | tail -1)
echo "   Using date: $LATEST_DATE"

S3_PREFIX="${BASE_PATH}/${FOLDER_NAME}/${LATEST_DATE}/"
echo "   Full path: s3://${BUCKET}/${S3_PREFIX}"

# Find model and vocab files in the S3 directory
echo "🔍 Searching for model files..."

# List files in the S3 directory
S3_FILES=$(aws s3 ls "s3://${BUCKET}/${S3_PREFIX}" --region "$REGION" 2>/dev/null | awk '{print $4}')

if [ -z "$S3_FILES" ]; then
    echo "❌ No files found in s3://${BUCKET}/${S3_PREFIX}"
    echo "Available language pairs might be:"
    aws s3 ls "s3://${BUCKET}/${BASE_PATH}/" --region "$REGION" | grep "PRE bergamot-" | head -5
    exit 1
fi

# Find model file (.intgemm.*.bin)
MODEL_FILE=$(echo "$S3_FILES" | grep -E "\.intgemm.*\.bin$" | head -1)
if [ -z "$MODEL_FILE" ]; then
    echo "❌ No model file (.intgemm.*.bin) found in directory"
    echo "Files found:"
    echo "$S3_FILES"
    exit 1
fi

# Find vocab file (.spm)
VOCAB_FILE=$(echo "$S3_FILES" | grep "\.spm$" | head -1)
if [ -z "$VOCAB_FILE" ]; then
    echo "❌ No vocab file (.spm) found in directory"
    echo "Files found:"
    echo "$S3_FILES"
    exit 1
fi

echo "   Found model: $MODEL_FILE"
echo "   Found vocab: $VOCAB_FILE"

# Full S3 keys
MODEL_KEY="${S3_PREFIX}${MODEL_FILE}"
VOCAB_KEY="${S3_PREFIX}${VOCAB_FILE}"

# Generate presigned URLs (valid for 1 hour = 3600 seconds)
echo "📝 Generating presigned URLs (valid for 1 hour)..."

MODEL_URL=$(aws s3 presign "s3://${BUCKET}/${MODEL_KEY}" --expires-in 3600 --region "$REGION")
VOCAB_URL=$(aws s3 presign "s3://${BUCKET}/${VOCAB_KEY}" --expires-in 3600 --region "$REGION")

if [ -z "$MODEL_URL" ] || [ -z "$VOCAB_URL" ]; then
    echo "❌ Failed to generate presigned URLs"
    exit 1
fi

echo "✅ Presigned URLs generated successfully"

# Export to GitHub Actions environment (if running in CI)
if [ -n "$GITHUB_ENV" ]; then
    echo "BERGAMOT_MODEL_URL=${MODEL_URL}" >> "$GITHUB_ENV"
    echo "BERGAMOT_VOCAB_URL=${VOCAB_URL}" >> "$GITHUB_ENV"
    echo "✅ URLs exported to GITHUB_ENV"
else
    # For local testing - output export commands
    echo ""
    echo "📋 Export these environment variables:"
    echo "export BERGAMOT_MODEL_URL=\"${MODEL_URL}\""
    echo "export BERGAMOT_VOCAB_URL=\"${VOCAB_URL}\""
fi

echo ""
echo "🎉 Ready to run mobile tests with Bergamot ${LANG_PAIR} model!"

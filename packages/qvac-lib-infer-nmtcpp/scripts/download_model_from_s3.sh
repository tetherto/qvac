#!/bin/bash
# Download a single language pair model from S3 for evaluation

set -e

# Configuration
BUCKET="${S3_BUCKET:-${MODEL_S3_BUCKET}}"
REGION="us-east-1"

# Check if credentials are set
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
    echo "❌ AWS credentials not set"
    echo ""
    echo "Set them first:"
    exit 1
fi

# Get quantization type from argument (default: q0f16)
# Options: q0f16 (f16), q4_0 (quantized 4-bit)
QUANT=${2:-"q0f16"}

# Get language pair from argument or use default
PAIR=${1:-"en-it"}
SRC_LANG=$(echo $PAIR | cut -d'-' -f1)
TRG_LANG=$(echo $PAIR | cut -d'-' -f2)

# Set base path based on quantization
if [ "$QUANT" = "q4_0" ]; then
    BASE_PATH="qvac_models_compiled/ggml/marian/q4_0"
    MODEL_SUFFIX="q4_0"
else
    BASE_PATH="qvac_models_compiled/ggml/marian/q0f16"
    MODEL_SUFFIX="f16"
fi

echo "=========================================="
echo "Downloading Model: $SRC_LANG → $TRG_LANG"
echo "Quantization: $QUANT"
echo "=========================================="
echo ""

# Navigate to repo root (assuming script is in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "Repository root: $REPO_ROOT"
echo ""

# Create models directory
MODELS_DIR="$REPO_ROOT/qvac_models/$PAIR"
mkdir -p "$MODELS_DIR"

echo "Target directory: $MODELS_DIR"
echo "Model suffix: $MODEL_SUFFIX"
echo ""

# S3 path
S3_PATH="s3://${BUCKET}/${BASE_PATH}/ggml-${PAIR}/"

echo "S3 Source: $S3_PATH"
echo ""

# List what's available in S3
echo "Checking available files in S3..."
FILES=$(aws s3 ls "$S3_PATH" --recursive --region "$REGION" 2>&1)

if [ $? -ne 0 ]; then
    echo "❌ Cannot access S3 path: $S3_PATH"
    echo ""
    echo "Error: $FILES"
    echo ""
    echo "Troubleshooting:"
    echo "1. Check if the language pair exists:"
    echo "   aws s3 ls s3://${BUCKET}/${BASE_PATH}/ --region ${REGION}"
    echo ""
    echo "2. Verify your credentials have S3 access"
    exit 1
fi

# Find the model file (.bin file)
MODEL_FILE=$(echo "$FILES" | grep "\.bin$" | tail -1 | awk '{print $4}')

if [ -z "$MODEL_FILE" ]; then
    echo "❌ No .bin model file found in S3 path"
    echo ""
    echo "Available files:"
    echo "$FILES" | head -10
    exit 1
fi

# Get the full S3 path to the model
FULL_S3_PATH="s3://${BUCKET}/${MODEL_FILE}"
MODEL_NAME=$(basename "$MODEL_FILE")

echo "Found model: $MODEL_NAME"
echo "Full S3 path: $FULL_S3_PATH"
echo ""

# Set output filename based on quantization
if [ "$QUANT" = "q4_0" ]; then
    OUTPUT_FILE="$MODELS_DIR/model_q4_0.bin"
else
    OUTPUT_FILE="$MODELS_DIR/model_f16.bin"
fi

# Download the model
echo "Downloading model..."
aws s3 cp "$FULL_S3_PATH" "$OUTPUT_FILE" --region "$REGION"

if [ $? -eq 0 ]; then
    echo "✅ Model downloaded successfully!"
    echo ""
    echo "Model location: $OUTPUT_FILE"
    echo "File size: $(ls -lh "$OUTPUT_FILE" | awk '{print $5}')"
    echo ""
    echo "=========================================="
    echo "Next Steps"
    echo "=========================================="
    echo ""
    echo "1. Run evaluation for this pair:"
    echo "   cd benchmarks/quality_eval"
    echo "   python3 evaluate.py --pairs $PAIR --translators qvac"
    echo ""
    echo "2. Or test with multiple translators:"
    echo "   python3 evaluate.py --pairs $PAIR --translators qvac"
    echo ""
    echo "Note: The translator will use this model automatically."
    echo ""
else
    echo "❌ Download failed"
    exit 1
fi

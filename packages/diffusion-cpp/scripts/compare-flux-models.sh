#!/usr/bin/env bash
set -euo pipefail

# Side-by-side comparison of Q8 vs F16 FLUX2 models
# This script runs both versions with identical settings for fair comparison

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "FLUX2 Model Comparison: Q8_0 vs F16"
echo "=========================================="
echo ""
echo "This will run both models with identical settings:"
echo "  - Same input image: nik_headshot_832.jpeg"
echo "  - Same seed: 1995"
echo "  - Same steps: 20"
echo "  - Same strength: 0.50"
echo "  - Same guidance: 7.0"
echo ""
echo "Output files:"
echo "  Q8_0: temp/nik_headshot_832_transformed.jpeg"
echo "  F16:  temp/nik_headshot_832_transformed_f16.png"
echo ""
read -p "Press Enter to start Q8_0 test..."

echo ""
echo "=========================================="
echo "Running Q8_0 (8-bit quantized)..."
echo "=========================================="
cd "$PROJECT_ROOT"
time bare examples/img2img-flux2.js

echo ""
echo ""
read -p "Press Enter to start F16 test..."

echo ""
echo "=========================================="
echo "Running F16 (full precision)..."
echo "=========================================="
time bare examples/img2img-flux2-f16.js

echo ""
echo ""
echo "=========================================="
echo "Comparison Complete!"
echo "=========================================="
echo ""
echo "Output files saved:"
echo "  Q8_0: $PROJECT_ROOT/temp/nik_headshot_832_transformed.jpeg"
echo "  F16:  $PROJECT_ROOT/temp/nik_headshot_832_transformed_f16.png"
echo ""
echo "Compare the images to check:"
echo "  1. Quality differences"
echo "  2. Bias/ethnicity preservation"
echo "  3. Generation time"
echo ""

#!/bin/bash

# FLUX2 img2img using Iris C engine
# This script uses the same settings as img2img-flux2.js

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
IRIS_BIN="$PROJECT_ROOT/temp/iris.c/iris"
MODEL_DIR="$PROJECT_ROOT/temp/iris.c/flux-klein-4b"
# INPUT_IMAGE="$PROJECT_ROOT/temp/benjaminrutz.jpeg"
INPUT_IMAGE="$PROJECT_ROOT/temp/nik_headshot_832.jpeg"

# OUTPUT_IMAGE="$PROJECT_ROOT/temp/benjaminrutz_transformed_iris.png"
OUTPUT_IMAGE="$PROJECT_ROOT/temp/nik_headshot_832_transformed_iris.png"

# Check if iris binary exists
if [ ! -f "$IRIS_BIN" ]; then
    echo "Error: iris binary not found at $IRIS_BIN"
    echo "Please build iris first: cd temp/iris.c && make mps"
    exit 1
fi

# Check if input image exists
if [ ! -f "$INPUT_IMAGE" ]; then
    echo "Error: Input image not found at $INPUT_IMAGE"
    exit 1
fi

# Settings from img2img-flux2.js
PROMPT="a female version of this photo, professional headshot, corporate lawyer"
STEPS=20
GUIDANCE=9.0
SEED=42

# Note: Iris doesn't have a separate "strength" parameter like the JS API.
# The img2img effect is controlled through the input image and guidance scale.

echo "Running FLUX2 img2img with Iris..."
echo "Input  : $INPUT_IMAGE"
echo "Output : $OUTPUT_IMAGE"
echo "Prompt : $PROMPT"
echo "Steps  : $STEPS"
echo "Guidance: $GUIDANCE"
echo "Seed   : $SEED"
echo ""

# Run iris
"$IRIS_BIN" \
    --dir "$MODEL_DIR" \
    --prompt "$PROMPT" \
    --input "$INPUT_IMAGE" \
    --output "$OUTPUT_IMAGE" \
    --steps $STEPS \
    --guidance $GUIDANCE \
    --seed $SEED \
    --verbose

echo ""
echo "Done! Output saved to: $OUTPUT_IMAGE"

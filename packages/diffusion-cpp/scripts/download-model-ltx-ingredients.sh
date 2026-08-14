#!/usr/bin/env bash
set -euo pipefail

# LTX-2.3 22B Ingredients IC-LoRA adapter.
#
# The adapter is gated by its upstream publisher. Before downloading, accept
# its license at:
# https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients
#
# Usage:
#   HF_TOKEN=hf_... ./scripts/download-model-ltx-ingredients.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$SCRIPT_DIR/.." && pwd)/models"
HF="https://huggingface.co"
REPO="Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients"
REPO_REV="6cddbc81d57fea05d3ab20d580cc9839c148d982"
MODEL="ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors"

if (( $# > 0 )); then
  echo "Usage: HF_TOKEN=hf_... $(basename "$0")" >&2
  exit 1
fi

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "HF_TOKEN is required because the Ingredients adapter is gated." >&2
  echo "Accept the license at $HF/$REPO, then export a Hugging Face read token." >&2
  exit 1
fi

mkdir -p "$OUT"
source "$SCRIPT_DIR/dl-functions.sh"

echo "Downloading LTX-2.3 Ingredients IC-LoRA to $OUT"
dl "$HF/$REPO/resolve/$REPO_REV/$MODEL" "$OUT/$MODEL"
echo "done → $OUT/$MODEL"

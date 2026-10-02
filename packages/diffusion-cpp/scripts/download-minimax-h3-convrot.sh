#!/usr/bin/env bash
set -euo pipefail

# Download the MiniMax-H3 FL2VA ConvRot files used by the H3 video examples.
# Accept the terms displayed at https://huggingface.co/Comfy-Org/MiniMax-H3
# and run `hf auth login` if access is required. No token is written here.

usage() {
  echo "Usage: $0 [destination] [--dry-run]" >&2
  echo "Set HF_REVISION to a commit SHA for reproducible validation." >&2
}

if ! command -v hf >/dev/null 2>&1; then
  echo "Hugging Face CLI 'hf' is required. Install with: python -m pip install -U huggingface_hub" >&2
  exit 1
fi

repo='Comfy-Org/MiniMax-H3'
destination='packages/diffusion-cpp/models/minimax-h3-comfy-int8-convrot'
revision="${HF_REVISION:-main}"
dry_run=false

if [[ $# -gt 0 && "$1" != '--dry-run' ]]; then
  destination="$1"
  shift
fi
if [[ $# -gt 0 && "$1" == '--dry-run' ]]; then
  dry_run=true
  shift
fi
if [[ $# -ne 0 ]]; then
  usage
  exit 2
fi

files=(
  'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors'
  'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors'
  'vae/minimax_h3_video_vae_fp16.safetensors'
  'vae/minimax_h3_audio_vae_fp32.safetensors'
)

echo "MiniMax-H3 terms: https://huggingface.co/Comfy-Org/MiniMax-H3"
echo "Destination: $destination"
echo "Revision: $revision"
echo 'Allow at least 55 GB for the four files, plus cache and build space.'

args=(download "$repo" "${files[@]}" --revision "$revision" --local-dir "$destination")
if [[ "$dry_run" == true ]]; then
  args+=(--dry-run)
fi
hf "${args[@]}"

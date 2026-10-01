#!/usr/bin/env bash
set -euo pipefail

# Download the MiniMax-H3 FL2VA ConvRot files used by the H3 video examples.
# Accept the terms displayed at https://huggingface.co/Comfy-Org/MiniMax-H3
# and run `hf auth login` if access is required. No token is written here.

usage() {
  echo "Usage: $0 [destination] [--dry-run]" >&2
  echo "Set HF_REVISION to a commit SHA for reproducible validation." >&2
  echo "Set H3_TEXT_ENCODER_VARIANT=nvfp4_awq for the ComfyUI NVFP4 encoder (default: int8_convrot)." >&2
}

if ! command -v hf >/dev/null 2>&1; then
  echo "Hugging Face CLI 'hf' is required. Install with: python -m pip install -U huggingface_hub" >&2
  exit 1
fi

repo='Comfy-Org/MiniMax-H3'
destination='packages/diffusion-cpp/models/minimax-h3-comfy-int8-convrot'
revision="${HF_REVISION:-main}"
text_encoder_variant="${H3_TEXT_ENCODER_VARIANT:-int8_convrot}"
dry_run=false

case "$text_encoder_variant" in
  int8_convrot)
    text_encoder='qwen3vl_32b_minimax_h3_int8_convrot.safetensors'
    space_hint='55 GB'
    ;;
  nvfp4_awq)
    text_encoder='qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
    space_hint='40 GB'
    ;;
  *)
    usage
    exit 2
    ;;
esac

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
  "text_encoders/$text_encoder"
  'vae/minimax_h3_video_vae_fp16.safetensors'
  'vae/minimax_h3_audio_vae_fp32.safetensors'
)

echo "MiniMax-H3 terms: https://huggingface.co/Comfy-Org/MiniMax-H3"
echo "Destination: $destination"
echo "Revision: $revision"
echo "Text encoder: $text_encoder"
echo "Allow at least $space_hint for the four files, plus cache and build space."

args=(download "$repo" "${files[@]}" --revision "$revision" --local-dir "$destination")
if [[ "$dry_run" == true ]]; then
  printf 'Would run: hf'
  printf ' %q' "${args[@]}"
  printf '\n'
  exit 0
fi
hf "${args[@]}"

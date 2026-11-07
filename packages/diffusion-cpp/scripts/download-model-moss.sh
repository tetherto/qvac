#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${MOSS_MODELS_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/models/moss-image}"
HF=https://huggingface.co
mkdir -p "$OUT"

check_hash() {
  if command -v sha256sum >/dev/null; then
    printf '%s  %s\n' "$2" "$1" | sha256sum -c -
  else
    printf '%s  %s\n' "$2" "$1" | shasum -a 256 -c -
  fi
}
fetch() {
  local repo="$1" revision="$2" source="$3" name="$4" hash="$5"
  if [[ -f "$OUT/$name" ]] && check_hash "$OUT/$name" "$hash"; then return; fi
  curl --fail --location --retry 5 --continue-at - \
    "$HF/$repo/resolve/$revision/$source" -o "$OUT/$name.part"
  if ! check_hash "$OUT/$name.part" "$hash"; then
    rm -f -- "$OUT/$name.part"
    return 1
  fi
  mv "$OUT/$name.part" "$OUT/$name"
}
fetch Comfy-Org/MOSS-Image 530a4c94f92c35ef6818b1b035a983fe9dcf5f54 \
  diffusion_models/moss_image_sft_bf16.safetensors moss_image_sft_bf16.safetensors \
  f96738d8116d78b7316b57c663d8c98591ddafab7488f48e3099b7655e34ab6f
fetch Comfy-Org/MOSS-Image 530a4c94f92c35ef6818b1b035a983fe9dcf5f54 \
  vae/flux2-vae_small.safetensors flux2-vae_small.safetensors \
  d8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b
fetch unsloth/Qwen3.5-9B-GGUF 3885219b6810b007914f3a7950a8d1b469d598a5 \
  Qwen3.5-9B-Q4_K_M.gguf Qwen3.5-9B-Q4_K_M.gguf \
  03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8
fetch OpenMOSS-Team/MOSS-Image-SFT f972bd4b4b9e3852133cc5da954d87bc32cd8fb9 \
  tokenizer/tokenizer.json tokenizer.json \
  06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523
printf 'Models verified in %s\n' "$OUT"

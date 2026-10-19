#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${QWEN_MODELS_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/models/qwen-image-21}"
HF=https://huggingface.co
mkdir -p "$OUT"

# Model terms: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/d26bb61231c349cf6b7896fa83353113880e1ba3/LICENSE
# Encoder/projector: Apache-2.0. Weights retain their own licenses.
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
fetch leejet/Qwen-Image-2.1-GGUF cc11433936a06e9765f7c0c0b1f0436cfd2b9856 \
  qwen_image_2.1-Q4_K.gguf qwen_image_2.1-Q4_K.gguf \
  29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2
fetch Qwen/Qwen3-VL-8B-Instruct-GGUF f982a07559d4a2f6c8744d840bf6fccab30eea96 \
  Qwen3VL-8B-Instruct-Q4_K_M.gguf Qwen3VL-8B-Instruct-Q4_K_M.gguf \
  67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2
fetch Qwen/Qwen3-VL-8B-Instruct-GGUF f982a07559d4a2f6c8744d840bf6fccab30eea96 \
  mmproj-Qwen3VL-8B-Instruct-F16.gguf mmproj-Qwen3VL-8B-Instruct-F16.gguf \
  ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38
fetch Comfy-Org/Qwen-Image-2.1 a8342359c61979b06a8dafb1a47991fe1f30e994 \
  vae/qwen_image_2.1_vae_bf16.safetensors qwen_image_2.1_vae_bf16.safetensors \
  bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9
printf 'Models verified in %s\n' "$OUT"

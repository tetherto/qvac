#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${FLUX3_MODELS_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/models/flux3}"
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
  local repo="$1" revision="$2" source="$3" name="$4" hash="$5" gated="${6:-false}"
  local -a auth=()
  if [[ -f "$OUT/$name" ]] && check_hash "$OUT/$name" "$hash"; then return; fi
  if [[ "$gated" == true ]]; then
    if [[ -z "${HF_TOKEN:-}" ]]; then
      printf '%s\n' 'HF_TOKEN is required to download the gated FLUX.3 VAE. Accept the model terms at https://huggingface.co/black-forest-labs/flux-3-image-klein first.' >&2
      return 1
    fi
    auth=(--header "Authorization: Bearer $HF_TOKEN")
  fi
  curl --fail --location --retry 5 --continue-at - "${auth[@]}" \
    "$HF/$repo/resolve/$revision/$source" -o "$OUT/$name.part"
  if ! check_hash "$OUT/$name.part" "$hash"; then
    rm -f -- "$OUT/$name.part"
    return 1
  fi
  mv "$OUT/$name.part" "$OUT/$name"
}

# Fetch the gated VAE first so an authorization failure precedes larger downloads.
# Weights retain the licenses and access terms of their source repositories.
fetch black-forest-labs/flux-3-image-klein 09561231f44e41381c461caf53d5452005a60ac9 \
  ae.safetensors flux3-vae.safetensors \
  868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3 true
fetch leejet/flux-3-image-klein-GGUF 1c2ad2f9b9247ccca6506a23bdb033fdb0873321 \
  flux3-image-klein-Q8_0.gguf flux3-image-klein-Q8_0.gguf \
  8b71ffd749bcacbd50cc0acca4f2d31a044c94412743e1e780db99bf13f89752
fetch Qwen/Qwen3-VL-4B-Instruct-GGUF 1cd86afb9a95c410a6038ab3b40d8b578c892266 \
  Qwen3VL-4B-Instruct-Q4_K_M.gguf Qwen3VL-4B-Instruct-Q4_K_M.gguf \
  66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a
printf 'Models verified in %s\n' "$OUT"

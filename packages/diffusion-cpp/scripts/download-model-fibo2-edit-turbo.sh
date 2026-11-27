#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${FIBO_MODELS_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/models/fibo2-edit-turbo}"
HF=https://huggingface.co
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: bash scripts/download-model-fibo2-edit-turbo.sh [--dry-run]

Download Fibo 2.0 Edit Turbo Q4_0, Qwen3-VL-4B Q4_K_M, its F16 vision
projector, and the FLUX.2 VAE (8,540,063,644 bytes total).
Default output: package-relative models/fibo2-edit-turbo.
Set FIBO_MODELS_DIR to override the output directory.

--dry-run  Print pinned URLs, sizes, hashes, and destinations without writing
           files or accessing the network.
--help     Show this help.

Public downloads do not require a token. Existing files are checksum-verified;
interrupted transfers resume from .part files. Only verified files are promoted.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$DRY_RUN" == false ]]; then
  command -v curl >/dev/null || { printf 'curl is required.\n' >&2; exit 1; }
  if command -v sha256sum >/dev/null; then
    HASH_CMD=(sha256sum)
  elif command -v shasum >/dev/null; then
    HASH_CMD=(shasum -a 256)
  else
    printf 'sha256sum or shasum is required.\n' >&2
    exit 1
  fi
  mkdir -p -- "$OUT"
  LOCK_DIR="$OUT/.download-fibo2-edit-turbo.lock"
  if ! mkdir -- "$LOCK_DIR"; then
    printf 'Cannot lock %s. Check for another downloader or an unwritable directory.\n' "$OUT" >&2
    printf 'After an unclean shutdown, remove the empty lock directory only after confirming no download is running.\n' >&2
    exit 1
  fi
  trap 'rmdir -- "$LOCK_DIR" 2>/dev/null || true' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi

check_file() {
  local file="$1" hash="$2" bytes="$3" actual
  [[ -f "$file" ]] || return 1
  [[ "$(wc -c < "$file")" -eq "$bytes" ]] || return 1
  actual="$("${HASH_CMD[@]}" < "$file")"
  [[ "${actual%% *}" == "$hash" ]]
}

fetch() {
  local repo="$1" revision="$2" name="$3" hash="$4" bytes="$5"
  local url="$HF/$repo/resolve/$revision/$name" file="$OUT/$name" partial="$OUT/$name.part" status
  if [[ "$DRY_RUN" == true ]]; then
    printf '\n%s\n  URL: %s\n  Bytes: %s\n  SHA-256: %s\n' "$file" "$url" "$bytes" "$hash"
    return
  fi
  printf 'Checking %s\n' "$name"
  if check_file "$file" "$hash" "$bytes"; then
    printf 'Verified existing %s\n' "$name"
    return
  fi
  mkdir -p -- "$(dirname "$file")"
  if [[ -L "$partial" ]]; then
    printf 'Refusing to write through partial-file symlink: %s\n' "$partial" >&2
    return 1
  fi
  # A completed transfer may have been interrupted before its final rename.
  if check_file "$partial" "$hash" "$bytes"; then
    mv -f -- "$partial" "$file"
    printf 'Verified completed partial %s\n' "$name"
    return
  fi
  if [[ -f "$partial" && "$(wc -c < "$partial")" -ge "$bytes" ]]; then
    printf 'Discarding invalid completed partial: %s\n' "$partial" >&2
    rm -f -- "$partial"
  fi
  printf 'Downloading %s (%s bytes)\n' "$name" "$bytes"
  # Ignore personal curlrc options; these public artifacts need no credentials.
  if curl --disable --fail --location --retry 5 --connect-timeout 30 \
    --speed-limit 1024 --speed-time 120 --continue-at - \
    "$url" -o "$partial"; then
    :
  else
    status=$?
    printf 'Download failed for %s (curl exit %s). Rerun to resume any partial transfer.\n' "$name" "$status" >&2
    return "$status"
  fi
  if ! check_file "$partial" "$hash" "$bytes"; then
    printf 'Size or SHA-256 mismatch for %s; discarding partial. Rerun to retry.\n' "$name" >&2
    rm -f -- "$partial"
    return 1
  fi
  mv -f -- "$partial" "$file"
  printf 'Verified %s\n' "$name"
}

# Weights retain their source licenses; see ../docs/fibo2-edit-turbo.md.
# Fibo: https://huggingface.co/AbrahamPJ/fibo2-edit-turbo-q4_0-gguf
# Encoder/projector: https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF
# VAE: https://huggingface.co/Comfy-Org/Fibo-2.0
fetch AbrahamPJ/fibo2-edit-turbo-q4_0-gguf c9b682aa0b004624db6407ecd9dda419caacc1bf \
  fibo2_edit_turbo-q4_0.gguf \
  1d54ab89efae3bdab46154c53bd445e7904406646cc697af69110cb5d1abbe0f 4870390432
fetch Qwen/Qwen3-VL-4B-Instruct-GGUF 1cd86afb9a95c410a6038ab3b40d8b578c892266 \
  Qwen3VL-4B-Instruct-Q4_K_M.gguf \
  66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a 2497281664
fetch Qwen/Qwen3-VL-4B-Instruct-GGUF 1cd86afb9a95c410a6038ab3b40d8b578c892266 \
  mmproj-Qwen3VL-4B-Instruct-F16.gguf \
  256f3a43bd4205ffef48d6b92715e1e70b5b0e9aef06522584967513a9985331 836180256
fetch Comfy-Org/Fibo-2.0 4742d4bec410034142c8e65559e5f00c6f29eccb \
  vae/flux2-vae.safetensors \
  868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3 336211292

if [[ "$DRY_RUN" == true ]]; then
  printf '\nTotal download: 8540063644 bytes (8.54 GB / 7.95 GiB). Allow extra space for builds and outputs.\n'
else
  printf 'All four models verified in %s\n' "$OUT"
fi

#!/usr/bin/env bash
#
# Download upstream Parakeet `.nemo` checkpoints from HuggingFace
# into `./models/nemo/`. The ggml backend takes `.gguf` files;
# convert the staged `.nemo` archives with
# `./scripts/convert-nemo.sh` afterwards (or run
# `npm run setup-models` to do both in one go).
#
# Idempotent: skips files already present on disk.
#
# Usage:
#   ./scripts/download-models.sh [flags]
#
# Flags:
#   --type, -t <ctc|tdt|eou|sortformer|all>   Which model(s) (default: all)
#   --output, -o <path>                       Destination dir (default: ./models/nemo)
#   --force, -f                               Re-download even if present
#   --help, -h                                Show this help
#
# Examples:
#   ./scripts/download-models.sh                   # all four .nemo files
#   ./scripts/download-models.sh -t tdt            # just TDT
#   ./scripts/download-models.sh -t eou -o /tmp/m  # EOU into a custom dir

set -euo pipefail

TYPE="all"
OUTPUT_DIR="./models/nemo"
FORCE=0

print_usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# *//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type|-t)   TYPE="$2"; shift 2;;
    --output|-o) OUTPUT_DIR="$2"; shift 2;;
    --force|-f)  FORCE=1; shift;;
    --help|-h)   print_usage; exit 0;;
    *) echo "Unknown flag: $1" >&2; print_usage; exit 2;;
  esac
done

case "$TYPE" in
  ctc|tdt|eou|sortformer|all) ;;
  *) echo "Error: --type must be ctc|tdt|eou|sortformer|all" >&2; exit 2;;
esac

# Map model type -> { hf_repo, nemo_filename }
nemo_url() {
  case "$1" in
    ctc)        echo "https://huggingface.co/nvidia/parakeet-ctc-0.6b/resolve/main/parakeet-ctc-0.6b.nemo";;
    tdt)        echo "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/main/parakeet-tdt-0.6b-v3.nemo";;
    eou)        echo "https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1/resolve/main/parakeet_realtime_eou_120m-v1.nemo";;
    sortformer) echo "https://huggingface.co/nvidia/diar_sortformer_4spk-v1/resolve/main/diar_sortformer_4spk-v1.nemo";;
  esac
}
nemo_filename() {
  basename "$(nemo_url "$1")"
}

bytes_human() {
  local b=${1:-0}
  awk -v b="$b" 'BEGIN {
    if (b >= 1073741824) printf "%.2f GiB", b / 1073741824
    else if (b >= 1048576) printf "%.2f MiB", b / 1048576
    else printf "%d B", b
  }'
}

fetch_nemo() {
  local t="$1"
  local url; url=$(nemo_url "$t")
  local fname; fname=$(nemo_filename "$t")
  local dst="$OUTPUT_DIR/$fname"

  if [[ -f "$dst" ]] && [[ "$FORCE" -eq 0 ]]; then
    local sz; sz=$(stat -f%z "$dst" 2>/dev/null || stat -c%s "$dst" 2>/dev/null || echo 0)
    echo "  ✓ ${t}: already downloaded ($(bytes_human "$sz"))"
    return 0
  fi

  echo "  ↓ ${t}: ${url}"
  echo "       -> ${dst}"
  mkdir -p "$OUTPUT_DIR"
  curl -L --fail --progress-bar -o "$dst.tmp" "$url"
  mv "$dst.tmp" "$dst"
  local sz; sz=$(stat -f%z "$dst" 2>/dev/null || stat -c%s "$dst" 2>/dev/null || echo 0)
  echo "  ✓ ${t}: downloaded ($(bytes_human "$sz"))"
}

echo "Downloading .nemo checkpoint(s) -- type=${TYPE}"
echo "Output: ${OUTPUT_DIR}"
echo

if [[ "$TYPE" == "all" ]]; then
  for t in ctc tdt eou sortformer; do
    fetch_nemo "$t"
  done
else
  fetch_nemo "$TYPE"
fi

echo
echo "Next: convert .nemo -> .gguf"
echo "   ./scripts/convert-nemo.sh --type ${TYPE}"

#!/usr/bin/env bash
#
# Download upstream Resemble Chatterbox + Supertone Supertonic checkpoints
# and convert them into the single-file .gguf format the ggml backend
# consumes.  Wraps the in-tree converters under scripts/ (vendored from
# the standalone chatterbox.cpp repo; see each .py file's header
# comment).
#
# The converters fetch their source weights through huggingface_hub at
# convert time; there is no separate "download" step.  Models land in
# ./models/ by default.
#
# Requirements:
#   - A Python venv at ./venv with `gguf`, `numpy`, `torch`,
#     `safetensors`, `huggingface_hub`, `onnx` installed.  Run
#     `./scripts/setup-venv.sh` (or `npm run setup:venv`) once.
#
# Usage:
#   ./scripts/convert-models.sh [flags]
#
# Flags:
#   --type, -t <turbo|multilingual|supertonic|supertonic-en|supertonic-mtl|all>
#                                Which model family (default: all).
#                                supertonic = both supertonic-en + supertonic-mtl.
#   --quant, -q <f16|q8_0|q5_0|q4_0|f32>
#                                Chatterbox quant tier (default: f16).
#                                Mapped to --ftype for Supertonic, which
#                                only accepts f32 | f16 | q8_0; q5_0 / q4_0
#                                fall back to f16 there.
#   --python <bin>               Python interpreter (default: $PYTHON,
#                                then ./venv/bin/python, then
#                                ./venv/Scripts/python.exe, then python3)
#   --output, -o <path>          GGUF output dir (default: ./models)
#   --hf-token <token>           HuggingFace auth token, forwarded to
#                                each converter's --hf-token.  Optional;
#                                only needed for gated repos.
#   --force, -f                  Re-convert even if the .gguf already
#                                exists at the target path.
#   --help, -h                   Show this help.
#
# Examples:
#   ./scripts/convert-models.sh                          # all variants, f16
#   ./scripts/convert-models.sh -t turbo -q q8_0         # Turbo only, q8_0
#   ./scripts/convert-models.sh -t multilingual -q q4_0  # Multilingual q4_0
#   ./scripts/convert-models.sh -t supertonic            # Supertonic only

set -euo pipefail

TYPE="all"
QUANT="f16"
PYTHON_BIN="${PYTHON:-}"
OUTPUT_DIR="./models"
HF_TOKEN=""
FORCE=0

print_usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# *//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type|-t)   TYPE="$2"; shift 2;;
    --quant|-q)  QUANT="$2"; shift 2;;
    --python)    PYTHON_BIN="$2"; shift 2;;
    --output|-o) OUTPUT_DIR="$2"; shift 2;;
    --hf-token)  HF_TOKEN="$2"; shift 2;;
    --force|-f)  FORCE=1; shift;;
    --help|-h)   print_usage; exit 0;;
    *) echo "Unknown flag: $1" >&2; print_usage; exit 2;;
  esac
done

case "$TYPE" in
  turbo|multilingual|supertonic|supertonic-en|supertonic-mtl|all) ;;
  *) echo "Error: --type must be turbo|multilingual|supertonic|supertonic-en|supertonic-mtl|all" >&2; exit 2;;
esac
case "$QUANT" in
  f32|f16|q8_0|q5_0|q4_0) ;;
  *) echo "Error: --quant must be f32|f16|q8_0|q5_0|q4_0" >&2; exit 2;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x "$PKG_DIR/venv/bin/python" ]]; then
    PYTHON_BIN="$PKG_DIR/venv/bin/python"
  elif [[ -x "$PKG_DIR/venv/Scripts/python.exe" ]]; then
    PYTHON_BIN="$PKG_DIR/venv/Scripts/python.exe"
  else
    PYTHON_BIN="python3"
  fi
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 && [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Error: python interpreter not found: $PYTHON_BIN" >&2
  echo "       run \`npm run setup:venv\` or pass --python <bin>." >&2
  exit 1
fi

# Sanity-check the python env has the modules the converters need.
# Failing fast here is better than a cryptic ModuleNotFoundError dump
# halfway through a multi-GB download.
missing_modules=$("$PYTHON_BIN" -c '
import sys
mods = ["gguf", "numpy", "torch", "safetensors", "huggingface_hub", "onnx"]
missing = []
for m in mods:
    try:
        __import__(m)
    except ImportError:
        missing.append(m)
print(",".join(missing))
' 2>/dev/null || echo 'PYTHON_BROKEN')

if [[ "$missing_modules" == "PYTHON_BROKEN" ]]; then
  echo "Error: python interpreter $PYTHON_BIN failed to start." >&2
  exit 1
fi
if [[ -n "$missing_modules" ]]; then
  echo "Error: python at $PYTHON_BIN is missing required module(s): ${missing_modules//,/, }" >&2
  echo "       run \`npm run setup:venv\` to provision ./venv with scripts/requirements.txt," >&2
  echo "       or pass --python /path/to/venv/bin/python with those modules installed." >&2
  exit 1
fi

bytes_human() {
  local b=${1:-0}
  awk -v b="$b" 'BEGIN {
    if (b >= 1073741824) printf "%.2f GiB", b / 1073741824
    else if (b >= 1048576) printf "%.2f MiB", b / 1048576
    else printf "%d B", b
  }'
}

mkdir -p "$OUTPUT_DIR"

# Maps the unified --quant flag onto Supertonic's --ftype which only
# accepts f32 | f16 | q8_0.  Quantisation tiers below q8 fall back to
# f16; the Supertonic CFM diffusion is sensitive enough that lower
# tiers degrade audibly.
supertonic_ftype() {
  case "$QUANT" in
    f32)   echo "f32";;
    q8_0)  echo "q8_0";;
    *)     echo "f16";;  # f16, q5_0, q4_0 -> f16
  esac
}

is_skip() {
  # Returns 0 (true) if --force is off and the target file is non-empty.
  local path="$1"
  if [[ "$FORCE" -eq 1 ]]; then
    return 1
  fi
  if [[ -s "$path" ]]; then
    local sz; sz=$(stat -f%z "$path" 2>/dev/null || stat -c%s "$path" 2>/dev/null || echo 0)
    echo "  - $(basename "$path"): already converted ($(bytes_human "$sz")) -- pass --force to redo"
    return 0
  fi
  return 1
}

run_converter() {
  # $1 = label, $2 = converter script, rest = args
  local label="$1"; shift
  local converter="$1"; shift
  local out=""
  for ((i = 1; i <= $#; i++)); do
    if [[ "${!i}" == "--out" ]]; then
      local next=$((i + 1))
      out="${!next}"
    fi
  done

  echo "  > ${label}: converting"
  if ! "$PYTHON_BIN" "$SCRIPT_DIR/$converter" "$@"; then
    echo "  x ${label}: conversion failed (see python traceback above)" >&2
    [[ -n "$out" ]] && rm -f "$out"
    return 1
  fi
  if [[ -n "$out" ]] && [[ ! -s "$out" ]]; then
    echo "  x ${label}: produced empty output -- removing" >&2
    rm -f "$out"
    return 1
  fi
  if [[ -n "$out" ]]; then
    local sz; sz=$(stat -f%z "$out" 2>/dev/null || stat -c%s "$out" 2>/dev/null || echo 0)
    echo "  - ${label}: $(basename "$out") ($(bytes_human "$sz"))"
  fi
}

# NOTE on `${hf_args[@]+"${hf_args[@]}"}` below:
# Bash 3.2 (the system bash on macOS runners) treats `"${arr[@]}"` as
# unset-variable access when the array is empty AND `set -u` (nounset)
# is in effect, which `set -euo pipefail` at the top of this script
# enables.  CI on darwin-arm64 hits this with HF_TOKEN unset:
#   scripts/convert-models.sh: line 200: hf_args[@]: unbound variable
# The `${arr[@]+"${arr[@]}"}` idiom expands to the array if it's
# defined and to nothing otherwise — works under nounset on bash 3.2+.
# Don't simplify this back to `"${hf_args[@]}"` without testing on
# macOS bash 3.2 with HF_TOKEN unset.

convert_turbo() {
  local t3_out="$OUTPUT_DIR/chatterbox-t3-turbo.gguf"
  local s3_out="$OUTPUT_DIR/chatterbox-s3gen.gguf"
  local hf_args=()
  [[ -n "$HF_TOKEN" ]] && hf_args=(--hf-token "$HF_TOKEN")

  if ! is_skip "$t3_out"; then
    run_converter "Turbo T3"    convert-t3-turbo-to-gguf.py \
      --out "$t3_out" --quant "$QUANT" ${hf_args[@]+"${hf_args[@]}"} || return 1
  fi
  if ! is_skip "$s3_out"; then
    run_converter "Turbo S3Gen" convert-s3gen-to-gguf.py \
      --variant turbo --out "$s3_out" --quant "$QUANT" ${hf_args[@]+"${hf_args[@]}"} || return 1
  fi
}

convert_multilingual() {
  local t3_out="$OUTPUT_DIR/chatterbox-t3-mtl.gguf"
  local s3_out="$OUTPUT_DIR/chatterbox-s3gen-mtl.gguf"
  local hf_args=()
  [[ -n "$HF_TOKEN" ]] && hf_args=(--hf-token "$HF_TOKEN")

  if ! is_skip "$t3_out"; then
    run_converter "MTL T3"    convert-t3-mtl-to-gguf.py \
      --out "$t3_out" --quant "$QUANT" ${hf_args[@]+"${hf_args[@]}"} || return 1
  fi
  if ! is_skip "$s3_out"; then
    run_converter "MTL S3Gen" convert-s3gen-to-gguf.py \
      --variant mtl --out "$s3_out" --quant "$QUANT" ${hf_args[@]+"${hf_args[@]}"} || return 1
  fi
}

convert_supertonic_en() {
  # Pulls the English-only Supertone/supertonic checkpoint.  Cheaper /
  # smaller than supertonic-2 and is the default the addon's Supertonic
  # examples use.  Output file: models/supertonic.gguf.
  local out="$OUTPUT_DIR/supertonic.gguf"
  local ftype; ftype=$(supertonic_ftype)
  local hf_args=()
  [[ -n "$HF_TOKEN" ]] && hf_args=(--hf-token "$HF_TOKEN")

  if ! is_skip "$out"; then
    run_converter "Supertonic (English)" convert-supertonic2-to-gguf.py \
      --arch supertonic --out "$out" --ftype "$ftype" ${hf_args[@]+"${hf_args[@]}"} || return 1
  fi
}

convert_supertonic_mtl() {
  # Pulls the multilingual Supertone/supertonic-2 checkpoint.  Output
  # file: models/supertonic2.gguf.  Supports en/ko/es/pt/fr today via
  # tts-cpp's supertonic_preprocess.cpp::is_supported_language.
  local out="$OUTPUT_DIR/supertonic2.gguf"
  local ftype; ftype=$(supertonic_ftype)
  local hf_args=()
  [[ -n "$HF_TOKEN" ]] && hf_args=(--hf-token "$HF_TOKEN")

  if ! is_skip "$out"; then
    run_converter "Supertonic (multilingual)" convert-supertonic2-to-gguf.py \
      --arch supertonic2 --out "$out" --ftype "$ftype" ${hf_args[@]+"${hf_args[@]}"} || return 1
  fi
}

convert_supertonic() {
  # Bundle: convert both English + multilingual checkpoints, mirroring how
  # the chatterbox `multilingual` group converts both T3 + S3Gen.  Either
  # leg can be requested individually via --type supertonic-en /
  # --type supertonic-mtl.
  local rc=0
  convert_supertonic_en  || rc=$((rc + 1))
  convert_supertonic_mtl || rc=$((rc + 1))
  return $rc
}

echo "Converting upstream sources -> .gguf -- type=${TYPE} quant=${QUANT}"
echo "Python:   ${PYTHON_BIN}"
echo "Output:   ${OUTPUT_DIR}"
echo

failures=0
case "$TYPE" in
  turbo)          convert_turbo          || failures=$((failures + 1));;
  multilingual)   convert_multilingual   || failures=$((failures + 1));;
  supertonic-en)  convert_supertonic_en  || failures=$((failures + 1));;
  supertonic-mtl) convert_supertonic_mtl || failures=$((failures + 1));;
  supertonic)     convert_supertonic     || failures=$((failures + 1));;
  all)
    convert_turbo        || failures=$((failures + 1))
    convert_multilingual || failures=$((failures + 1))
    convert_supertonic   || failures=$((failures + 1))
    ;;
esac

echo
if [[ "$failures" -gt 0 ]]; then
  echo "${failures} conversion(s) failed -- see warnings above." >&2
  exit 1
fi
echo "All conversions complete.  Try:"
echo "  bare examples/chatterbox-tts.js \"Hello from qvac tts ggml.\""

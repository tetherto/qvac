#!/usr/bin/env bash
#
# Convert staged Parakeet `.nemo` checkpoints into the single-file
# `.gguf` format the ggml backend consumes. Wraps the in-tree
# `scripts/convert-nemo-to-gguf.py` (vendored from 
# qvac-ext-lib-whisper.cpp/parakeet-cpp/scripts).
#
# Requirements:
#   - A Python venv at ./venv with `gguf`, `numpy`, `torch`, `pyyaml`
#     installed. Run `./scripts/setup-venv.sh` (or `npm run setup:venv`)
#     once -- the converter does not depend on the heavy `nemo_toolkit`
#     package, despite the .nemo extension.
#   - The downloaded `.nemo` files in ./models/nemo (run
#     `./scripts/download-models.sh` first).
#
# Usage:
#   ./scripts/convert-nemo.sh [flags]
#
# Flags:
#   --type, -t <ctc|tdt|eou|sortformer|sortformer-streaming-v2.1|all>
#                                               Which model(s) (default: all)
#   --quant, -q <f16|q8_0|q5_0|q4_0|f32>        Quant tier (default: q8_0)
#   --python <bin>                              Python interpreter (default:
#                                                $PYTHON, then ./venv/bin/python,
#                                                then ./venv/Scripts/python.exe,
#                                                then python3 from PATH)
#   --nemo-dir <path>                           Source .nemo dir
#                                               (default: ./models/nemo)
#   --output, -o <path>                         GGUF output dir
#                                               (default: ./models)
#   --force, -f                                 Re-convert even if .gguf exists
#   --help, -h                                  Show this help
#
# Examples:
#   ./scripts/convert-nemo.sh                          # all 4, q8_0
#   ./scripts/convert-nemo.sh -t tdt -q q4_0           # TDT q4_0 only
#   ./scripts/convert-nemo.sh --python /usr/local/bin/python3.11

set -euo pipefail

TYPE="all"
QUANT="q8_0"
PYTHON_BIN="${PYTHON:-}"
NEMO_DIR="./models/nemo"
OUTPUT_DIR="./models"
FORCE=0

print_usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# *//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type|-t)   TYPE="$2"; shift 2;;
    --quant|-q)  QUANT="$2"; shift 2;;
    --python)    PYTHON_BIN="$2"; shift 2;;
    --nemo-dir)  NEMO_DIR="$2"; shift 2;;
    --output|-o) OUTPUT_DIR="$2"; shift 2;;
    --force|-f)  FORCE=1; shift;;
    --help|-h)   print_usage; exit 0;;
    *) echo "Unknown flag: $1" >&2; print_usage; exit 2;;
  esac
done

case "$TYPE" in
  ctc|tdt|eou|sortformer|sortformer-streaming-v2.1|all) ;;
  *) echo "Error: --type must be ctc|tdt|eou|sortformer|sortformer-streaming-v2.1|all" >&2; exit 2;;
esac
case "$QUANT" in
  f32|f16|q8_0|q5_0|q4_0) ;;
  *) echo "Error: --quant must be f32|f16|q8_0|q5_0|q4_0" >&2; exit 2;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONVERTER="$SCRIPT_DIR/convert-nemo-to-gguf.py"

if [[ ! -f "$CONVERTER" ]]; then
  echo "Error: converter not found at $CONVERTER" >&2
  echo "       (the vendored copy should sit next to this script)" >&2
  exit 1
fi

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

# Sanity-check the python env has the modules the converter needs.
# Failing fast here is better than a cryptic ModuleNotFoundError dump
# in the middle of the first model.
missing_modules=$("$PYTHON_BIN" -c '
import sys
mods = ["gguf", "numpy", "torch", "yaml"]
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

nemo_filename() {
  case "$1" in
    ctc)        echo "parakeet-ctc-0.6b.nemo";;
    tdt)        echo "parakeet-tdt-0.6b-v3.nemo";;
    eou)        echo "parakeet_realtime_eou_120m-v1.nemo";;
    sortformer) echo "diar_sortformer_4spk-v1.nemo";;
    sortformer-streaming-v2.1) echo "diar_streaming_sortformer_4spk-v2.1.nemo";;
  esac
}
gguf_filename() {
  local t="$1" q="$2"
  case "$t" in
    ctc)        echo "parakeet-ctc-0.6b.${q}.gguf";;
    tdt)        echo "parakeet-tdt-0.6b-v3.${q}.gguf";;
    eou)        echo "parakeet-eou-120m-v1.${q}.gguf";;
    sortformer) echo "sortformer-4spk-v1.${q}.gguf";;
    sortformer-streaming-v2.1) echo "diar_streaming_sortformer_4spk-v2.1.${q}.gguf";;
  esac
}

bytes_human() {
  local b=${1:-0}
  awk -v b="$b" 'BEGIN {
    if (b >= 1073741824) printf "%.2f GiB", b / 1073741824
    else if (b >= 1048576) printf "%.2f MiB", b / 1048576
    else printf "%d B", b
  }'
}

convert_one() {
  local t="$1"
  local nemo; nemo="$NEMO_DIR/$(nemo_filename "$t")"
  local gguf; gguf="$OUTPUT_DIR/$(gguf_filename "$t" "$QUANT")"

  if [[ ! -f "$nemo" ]]; then
    echo "  x ${t}: .nemo missing -- expected ${nemo}"
    echo "         run \`./scripts/download-models.sh -t ${t}\` first."
    return 1
  fi
  if [[ -f "$gguf" ]] && [[ "$FORCE" -eq 0 ]]; then
    local sz; sz=$(stat -f%z "$gguf" 2>/dev/null || stat -c%s "$gguf" 2>/dev/null || echo 0)
    if [[ "$sz" -gt 0 ]]; then
      echo "  - ${t}: already converted ($(bytes_human "$sz")) -- pass --force to redo"
      return 0
    fi
    rm -f "$gguf"
  fi

  mkdir -p "$OUTPUT_DIR"
  echo "  > ${t}: converting at quant=${QUANT}"
  if ! "$PYTHON_BIN" "$CONVERTER" \
        --ckpt  "$nemo" \
        --out   "$gguf" \
        --quant "$QUANT"; then
    echo "  x ${t}: conversion failed (see python traceback above)"
    rm -f "$gguf"
    return 1
  fi
  if [[ ! -s "$gguf" ]]; then
    echo "  x ${t}: conversion produced an empty file -- removing"
    rm -f "$gguf"
    return 1
  fi
  local sz; sz=$(stat -f%z "$gguf" 2>/dev/null || stat -c%s "$gguf" 2>/dev/null || echo 0)
  echo "  - ${t}: $(basename "$gguf") ($(bytes_human "$sz"))"
}

echo "Converting .nemo -> .gguf -- type=${TYPE} quant=${QUANT}"
echo "Converter: ${CONVERTER}"
echo "Python:    ${PYTHON_BIN}"
echo ".nemo dir: ${NEMO_DIR}"
echo "Output:    ${OUTPUT_DIR}"
echo

failures=0
if [[ "$TYPE" == "all" ]]; then
  for t in ctc tdt eou sortformer sortformer-streaming-v2.1; do
    convert_one "$t" || failures=$((failures + 1))
  done
else
  convert_one "$TYPE" || failures=$((failures + 1))
fi

echo
if [[ "$failures" -gt 0 ]]; then
  echo "${failures} conversion(s) failed -- see warnings above." >&2
  exit 1
fi
echo "All conversions complete. Try:"
echo "  bare examples/transcribe.js \\"
echo "       -m ${OUTPUT_DIR}/$(gguf_filename "${TYPE/all/tdt}" "$QUANT") \\"
echo "       -a examples/samples/sample-16k.wav"

#!/usr/bin/env bash
#
# Thin wrapper around scripts/pth_to_gguf.py that:
#   - auto-discovers the package-local venv at ./venv
#   - sanity-checks the venv has the four required modules
#     (gguf, numpy, torch, easyocr) and fails fast with a helpful hint
#     if not
#   - creates the output's parent directory
#   - forwards all positional args + flags to the converter
#
# Usage:
#   ./scripts/convert-model.sh <input.pth> <output.gguf> [--arch NAME] [--quantize Q8_0|Q4_K]
#
# Flags:
#   --python <bin>   Override the Python interpreter. Default search
#                    order: $PYTHON, ./venv/bin/python,
#                    ./venv/Scripts/python.exe, python3.
#   --help, -h       Show this help.
#
# Examples:
#   ./scripts/convert-model.sh ~/.EasyOCR/model/craft_mlt_25k.pth models/craft_mlt_25k.gguf
#   ./scripts/convert-model.sh ~/.EasyOCR/model/english_g2.pth   models/english_g2.q8_0.gguf --quantize Q8_0
#   ./scripts/convert-model.sh ~/.EasyOCR/model/latin.pth        models/latin.q4_k.gguf      --quantize Q4_K
#
# If the package venv isn't present yet, provision it once with:
#   ./scripts/setup-venv.sh        (or:  npm run setup:venv)

set -euo pipefail

PYTHON_BIN="${PYTHON:-}"
CONVERTER_ARGS=()

print_usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# *//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)  PYTHON_BIN="$2"; shift 2;;
    --help|-h) print_usage; exit 0;;
    --)        shift; CONVERTER_ARGS+=("$@"); break;;
    *)         CONVERTER_ARGS+=("$1"); shift;;
  esac
done

if [[ ${#CONVERTER_ARGS[@]} -lt 2 ]]; then
  echo "Error: usage: $0 <input.pth> <output.gguf> [--arch NAME] [--quantize Q8_0|Q4_K]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONVERTER="$SCRIPT_DIR/pth_to_gguf.py"

if [[ ! -f "$CONVERTER" ]]; then
  echo "Error: converter not found at $CONVERTER" >&2
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
# Failing fast here is friendlier than a cryptic ModuleNotFoundError
# halfway through a multi-second torch.load call.
missing_modules=$("$PYTHON_BIN" -c '
import sys
mods = ["gguf", "numpy", "torch", "easyocr"]
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

OUT_PATH="${CONVERTER_ARGS[1]}"
OUT_DIR="$(dirname "$OUT_PATH")"
mkdir -p "$OUT_DIR"

echo "Converting EasyOCR .pth -> .gguf"
echo "Python:    $PYTHON_BIN"
echo "Converter: $CONVERTER"
echo "Args:      ${CONVERTER_ARGS[*]}"
echo

exec "$PYTHON_BIN" "$CONVERTER" "${CONVERTER_ARGS[@]}"

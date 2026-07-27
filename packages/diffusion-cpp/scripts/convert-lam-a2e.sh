#!/usr/bin/env bash
#
# Thin wrapper around scripts/convert-lam-a2e-to-gguf.py that:
#   - fetches the upstream checkpoint when --checkpoint is omitted
#   - auto-discovers the package-local venv at ./venv
#   - sanity-checks the venv has the three required modules
#     (gguf, numpy, torch) and fails fast with a helpful hint if not
#   - forwards all flags to the converter
#
# Usage:
#   ./scripts/convert-lam-a2e.sh --out <output.gguf> [--dtype f32|f16]
#   ./scripts/convert-lam-a2e.sh --checkpoint <checkpoint.tar> --out <output.gguf>
#
# Flags:
#   --checkpoint <f> Use a local checkpoint. Omit to download the upstream
#                    one (Apache-2.0, ~373MB) into --download-dir.
#   --download-dir <d>
#                    Where the download is cached. Default: ./.cache/lam-a2e.
#                    An existing checkpoint there is reused, so repeat runs
#                    cost nothing.
#   --python <bin>   Override the Python interpreter. Default search
#                    order: $PYTHON, ./venv/bin/python,
#                    ./venv/Scripts/python.exe, python3.
#   --help, -h       Show this help.
#
# Examples:
#   ./scripts/convert-lam-a2e.sh --out models/lam-audio2exp-f32.gguf
#   ./scripts/convert-lam-a2e.sh --out models/lam-audio2exp-f16.gguf --dtype f16
#   ./scripts/convert-lam-a2e.sh --checkpoint lam_audio2exp_streaming.tar --out models/lam-audio2exp-f32.gguf
#
# To remap an existing raw GGUF instead of converting a .tar checkpoint, call
# scripts/remap-lam-a2e-gguf.py directly (see README-lam-a2e.md).
#
# If the package venv isn't present yet, provision it once with:
#   ./scripts/setup-venv.sh        (or:  npm run setup:venv)

set -euo pipefail

# Upstream checkpoint (Apache-2.0). The download is an *outer* archive that
# expands to pretrained_models/lam_audio2exp_streaming.tar — lowercase, and
# that inner file is the one torch.load wants.
CHECKPOINT_URL="https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LAM/LAM_audio2exp_streaming.tar"
ARCHIVE_NAME="LAM_audio2exp_streaming.tar"
INNER_CHECKPOINT="pretrained_models/lam_audio2exp_streaming.tar"
ARCHIVE_BYTES=373377643

PYTHON_BIN="${PYTHON:-}"
DOWNLOAD_DIR=""
HAVE_CHECKPOINT=0
CONVERTER_ARGS=()

print_usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# *//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)       PYTHON_BIN="$2"; shift 2;;
    --download-dir) DOWNLOAD_DIR="$2"; shift 2;;
    --checkpoint)   HAVE_CHECKPOINT=1; CONVERTER_ARGS+=("$1" "$2"); shift 2;;
    --checkpoint=*) HAVE_CHECKPOINT=1; CONVERTER_ARGS+=("$1"); shift;;
    --help|-h)      print_usage; exit 0;;
    --)             shift; CONVERTER_ARGS+=("$@"); break;;
    *)              CONVERTER_ARGS+=("$1"); shift;;
  esac
done

if [[ ${#CONVERTER_ARGS[@]} -eq 0 ]]; then
  echo "Error: usage: $0 --out <output.gguf> [--checkpoint <checkpoint.tar>] [--dtype f32|f16]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONVERTER="$SCRIPT_DIR/convert-lam-a2e-to-gguf.py"

if [[ ! -f "$CONVERTER" ]]; then
  echo "Error: converter not found at $CONVERTER" >&2
  exit 1
fi

# No --checkpoint given: fetch the upstream one.
if [[ $HAVE_CHECKPOINT -eq 0 ]]; then
  DOWNLOAD_DIR="${DOWNLOAD_DIR:-$PKG_DIR/.cache/lam-a2e}"
  mkdir -p "$DOWNLOAD_DIR"
  archive="$DOWNLOAD_DIR/$ARCHIVE_NAME"
  checkpoint="$DOWNLOAD_DIR/$INNER_CHECKPOINT"

  if [[ -f "$checkpoint" ]]; then
    echo "Using cached checkpoint: $checkpoint"
  else
    if ! command -v wget >/dev/null 2>&1; then
      echo "Error: wget not found; install it or pass --checkpoint <file>." >&2
      exit 1
    fi

    # -c resumes a partial file, so an interrupted 373MB pull is not restarted
    # from zero. It is deliberately not combined with -O, which breaks resume;
    # instead wget runs in the target dir and takes the name from the URL.
    # Size is checked afterwards because a truncated tar fails deep inside
    # torch.load with an unhelpful message.
    echo "Downloading checkpoint (~373MB) to $archive"
    (cd "$DOWNLOAD_DIR" && wget -c "$CHECKPOINT_URL")

    actual_bytes=$(wc -c <"$archive")
    if [[ "$actual_bytes" -ne "$ARCHIVE_BYTES" ]]; then
      echo "Error: download is $actual_bytes bytes, expected $ARCHIVE_BYTES." >&2
      echo "       delete $archive and retry." >&2
      exit 1
    fi

    echo "Extracting $INNER_CHECKPOINT"
    tar -xf "$archive" -C "$DOWNLOAD_DIR" "$INNER_CHECKPOINT"

    if [[ ! -f "$checkpoint" ]]; then
      echo "Error: expected $checkpoint inside the archive, not found." >&2
      exit 1
    fi
  fi

  CONVERTER_ARGS+=(--checkpoint "$checkpoint")
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
mods = ["gguf", "numpy", "torch"]
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

echo "Converting LAM Audio2Expression checkpoint -> .gguf"
echo "Python:    $PYTHON_BIN"
echo "Converter: $CONVERTER"
echo "Args:      ${CONVERTER_ARGS[*]}"
echo

exec "$PYTHON_BIN" "$CONVERTER" "${CONVERTER_ARGS[@]}"

#!/usr/bin/env bash
#
# Create a local Python venv at ./venv with the packages the
# Chatterbox + Supertonic source -> GGUF converters need (see
# scripts/requirements.txt).  Idempotent: safe to re-run.
#
# Usage:
#   ./scripts/setup-venv.sh [flags]
#
# Flags:
#   --python <bin>  Base interpreter to seed the venv (default: $PYTHON
#                   or python3).  Must be CPython 3.10+.
#   --venv <path>   Venv location (default: ./venv)
#   --force         Recreate the venv even if ./venv already exists
#   --help, -h      Show this help
#
# The converters inside the venv are invoked via scripts/convert-models.sh,
# which auto-discovers ./venv/{bin,Scripts}/python before falling back to
# the system python3.

set -euo pipefail

PYTHON_BIN="${PYTHON:-}"
VENV_DIR="./venv"
FORCE=0

print_usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# *//' >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)  PYTHON_BIN="$2"; shift 2;;
    --venv)    VENV_DIR="$2"; shift 2;;
    --force)   FORCE=1; shift;;
    --help|-h) print_usage; exit 0;;
    *) echo "Unknown flag: $1" >&2; print_usage; exit 2;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REQS="$SCRIPT_DIR/requirements.txt"

if [[ ! -f "$REQS" ]]; then
  echo "Error: requirements.txt not found at $REQS" >&2
  exit 1
fi

# Pick a sane default interpreter when --python / PYTHON wasn't set.
# On Windows under Git Bash, $PATH's `python3` is often the MSYS2 / UCRT
# Python (platform tag mingw_x86_64_ucrt_gnu) which has zero wheels on
# PyPI for numpy / torch / friends, so pip falls back to a source build
# and needs Ninja + a C++ toolchain just to install numpy.  The Windows
# Python launcher (`py -3`) finds the real CPython (platform tag
# win-amd64) which has wheels for everything.  Resolve `py -3` to its
# absolute path so the rest of this script can treat PYTHON_BIN as a
# single argv[0].
if [[ -z "$PYTHON_BIN" ]]; then
  if command -v py >/dev/null 2>&1; then
    if resolved=$(py -3 -c 'import sys; print(sys.executable)' 2>/dev/null) && [[ -n "$resolved" ]]; then
      PYTHON_BIN="$resolved"
    fi
  fi
fi
if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    PYTHON_BIN="python3"
  fi
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 && [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Error: python interpreter not found: $PYTHON_BIN" >&2
  echo "       pass --python /path/to/python (CPython 3.10+ required)." >&2
  exit 1
fi

base_platform=$("$PYTHON_BIN" -c 'import sysconfig; print(sysconfig.get_platform())' 2>/dev/null || echo "unknown")
case "$base_platform" in
  mingw*|cygwin*|msys*)
    echo "Error: $PYTHON_BIN reports platform '$base_platform'." >&2
    echo "       PyPI does not ship binary wheels for that platform tag, so" >&2
    echo "       pip would fall back to building numpy / torch from source." >&2
    echo "       Use a native Windows CPython instead, e.g.:" >&2
    echo "         npm run setup-models -- --python \"\$(py -3 -c 'import sys; print(sys.executable)')\"" >&2
    echo "       or install Python from https://www.python.org/downloads/windows/" >&2
    echo "       and re-run with PYTHON=/c/Python313/python.exe (or similar)." >&2
    exit 1
    ;;
esac

# Cross-platform: Unix venvs put the interpreter at venv/bin/python,
# Windows ones at venv/Scripts/python.exe.  Probe both.
venv_python() {
  local v="$1"
  if [[ -x "$v/bin/python" ]]; then
    echo "$v/bin/python"
  elif [[ -x "$v/Scripts/python.exe" ]]; then
    echo "$v/Scripts/python.exe"
  else
    echo ""
  fi
}

if [[ "$FORCE" -eq 1 ]] && [[ -d "$VENV_DIR" ]]; then
  echo "Removing existing venv at $VENV_DIR (--force)"
  rm -rf "$VENV_DIR"
fi

if [[ -z "$(venv_python "$VENV_DIR")" ]]; then
  echo "Creating venv at $VENV_DIR using $PYTHON_BIN"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

VENV_PY="$(venv_python "$VENV_DIR")"
if [[ -z "$VENV_PY" ]]; then
  echo "Error: venv was created but no interpreter found under $VENV_DIR/bin or $VENV_DIR/Scripts" >&2
  exit 1
fi

echo "Using venv interpreter: $VENV_PY"
echo "Upgrading pip"
"$VENV_PY" -m pip install --upgrade pip >/dev/null

echo "Installing $REQS"
"$VENV_PY" -m pip install -r "$REQS"

echo
echo "Venv ready.  Next: ./scripts/convert-models.sh"
echo "(or:   npm run setup-models)"

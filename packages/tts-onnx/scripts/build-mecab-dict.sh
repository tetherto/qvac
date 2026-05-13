#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DICT_OUT_DIR="$PACKAGE_DIR/dict/mecab-ipadic"
WORK_DIR="$(mktemp -d)"

IPADIC_VERSION="2.7.0-20070801"
IPADIC_TARBALL="mecab-ipadic-${IPADIC_VERSION}.tar.gz"
IPADIC_URL="https://sourceforge.net/projects/mecab/files/mecab-ipadic/${IPADIC_VERSION}/${IPADIC_TARBALL}/download"

CHARSET="utf-8"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    echo "On macOS install with: brew install mecab" >&2
    exit 1
  fi
}

download_source() {
  echo "Downloading IPAdic source from SourceForge..."
  curl -fL --retry 3 -o "$WORK_DIR/$IPADIC_TARBALL" "$IPADIC_URL"
}

extract_source() {
  echo "Extracting source tarball..."
  tar -xzf "$WORK_DIR/$IPADIC_TARBALL" -C "$WORK_DIR"
}

compile_dictionary() {
  local src_dir="$WORK_DIR/mecab-ipadic-${IPADIC_VERSION}"
  echo "Compiling dictionary into $DICT_OUT_DIR ..."
  rm -rf "$DICT_OUT_DIR"
  mkdir -p "$DICT_OUT_DIR"
  mecab-dict-index \
    -d "$src_dir" \
    -o "$DICT_OUT_DIR" \
    -f "$CHARSET" \
    -t "$CHARSET"
  cp "$src_dir/dicrc" "$DICT_OUT_DIR/dicrc"
  write_mecabrc
}

write_mecabrc() {
  cat > "$DICT_OUT_DIR/mecabrc" <<'EOF'
;
; Minimal MeCab configuration file used by qvac TTS.
; The dicdir is overridden at runtime via the -d flag.
;
dicdir = .
EOF
}

print_summary() {
  echo "Dictionary built successfully:"
  ls -lh "$DICT_OUT_DIR"
}

main() {
  require_command curl
  require_command tar
  require_command mecab-dict-index
  download_source
  extract_source
  compile_dictionary
  print_summary
}

main "$@"

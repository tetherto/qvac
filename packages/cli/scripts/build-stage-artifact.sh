#!/usr/bin/env bash
# Lays the per-host executables out the way pear-runtime-updater reads a drive
# (by-arch/<host>/app/<bin>, plus the package.json whose version it compares) for pear-ci to stage.
set -euo pipefail

ARTIFACTS_DIR="${1:-out/artifacts}"
OUTPUT_DIR="${2:-out/stage}"
PACKAGE_JSON_PATH="${PACKAGE_JSON_PATH:-package.json}"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/by-arch"

count=0
while IFS= read -r artifact; do
  arch="$(basename "$(dirname "$artifact")")"
  arch="${arch#qvac-cli-}"
  case "$arch" in
  linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64) bin="qvac" ;;
  win32-x64) bin="qvac.exe" ;;
  *)
    echo "Unknown artifact: $artifact, skipping" >&2
    continue
    ;;
  esac

  target="$OUTPUT_DIR/by-arch/$arch/app/$bin"
  mkdir -p "$(dirname "$target")"
  cp "$artifact" "$target"
  chmod +x "$target"
  count=$((count + 1))
done < <(find "$ARTIFACTS_DIR" -mindepth 2 -type f \( -name 'qvac' -o -name 'qvac.exe' \) | sort)

if [ "$count" -eq 0 ]; then
  echo "No qvac artifacts found in $ARTIFACTS_DIR" >&2
  exit 1
fi

(
  cd "$OUTPUT_DIR"
  find by-arch -type f \( -name 'qvac' -o -name 'qvac.exe' \) -print0 | sort -z | xargs -0 shasum -a 256 >checksums.sha256
)

cp "$PACKAGE_JSON_PATH" "$OUTPUT_DIR/package.json"

echo "wrote $count artifact(s) to $OUTPUT_DIR"

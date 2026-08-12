#!/usr/bin/env bash
# Bumps the `# fabric-src-hash:` comment in the qvac-fabric overlay portfile
# to a fresh hash of fabric source contents.
#
# This is ONLY needed when iterating on a local fabric checkout via the
# `QVAC_FABRIC_LOCAL_PATH` env-var override (Phase 0 fast-edit loop). In the
# default github-fetch mode the overlay is pinned by commit SHA + SHA512 and
# vcpkg invalidates the cache when those change.
#
# Why this script exists: vcpkg derives its ABI hash from the portfile
# contents, not from the source the portfile copies in. Without bumping a
# portfile-tracked field, local working-tree edits to fabric won't trigger a
# rebuild.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
package_root="$(cd "$here/.." && pwd)"
portfile="$package_root/vcpkg/ports/qvac-fabric/portfile.cmake"

if [ ! -f "$portfile" ]; then
  echo "sync-fabric-overlay: portfile not found at $portfile" >&2
  exit 1
fi

# Accept either QVAC_FABRIC_LOCAL_PATH (the overlay's runtime env var) or
# QVAC_FABRIC_SRC_DIR (legacy alias).
if [ -n "${QVAC_FABRIC_LOCAL_PATH:-}" ]; then
  fabric_dir="$QVAC_FABRIC_LOCAL_PATH"
elif [ -n "${QVAC_FABRIC_SRC_DIR:-}" ]; then
  fabric_dir="$QVAC_FABRIC_SRC_DIR"
else
  echo "sync-fabric-overlay: QVAC_FABRIC_LOCAL_PATH is not set." >&2
  echo "  Set QVAC_FABRIC_LOCAL_PATH=/path/to/qvac-fabric-llm.cpp" >&2
  echo "  or run ./scripts/rebuild-fabric.sh to use the default sibling checkout." >&2
  exit 1
fi

if [ -z "$fabric_dir" ] || [ ! -d "$fabric_dir" ]; then
  echo "sync-fabric-overlay: fabric checkout not found." >&2
  echo "  Tried (in order):" >&2
  echo "    QVAC_FABRIC_LOCAL_PATH=${QVAC_FABRIC_LOCAL_PATH:-<unset>}" >&2
  echo "    QVAC_FABRIC_SRC_DIR=${QVAC_FABRIC_SRC_DIR:-<unset>}" >&2
  exit 1
fi

if [ ! -f "$fabric_dir/CMakeLists.txt" ]; then
  echo "sync-fabric-overlay: $fabric_dir does not look like a fabric checkout" >&2
  exit 1
fi

# Hash source under fabric. `git ls-files` is preferred (fast, respects
# .gitignore) and includes untracked source files because local feature work
# often adds new fabric files before commit. Build outputs are filtered out
# explicitly so they do not churn the port ABI hash.
hash=$(
  cd "$fabric_dir" && {
    git ls-files --cached --others --exclude-standard 2>/dev/null \
      || find . -type f \
           -not -path '*/.git/*' \
           -not -path '*/.cargo*/*' \
           -not -path '*/build*/*' \
           -not -path '*/node_modules/*' \
           -not -path '*/target/*' \
           -not -path '*/__pycache__/*'
  } | awk '
    /\.(gguf|bin|png|jpg)$/ { next }
    /(^|\/)(build[^\/]*|node_modules|target|__pycache__|\.git|\.cache|\.cargo[^\/]*)(\/|$)/ { next }
    { print }
  ' | LC_ALL=C sort | xargs -I{} shasum "{}" 2>/dev/null | shasum | awk '{print $1}'
)

if [ -z "$hash" ] || [ "${#hash}" -lt 20 ]; then
  echo "sync-fabric-overlay: failed to compute fabric source hash" >&2
  exit 1
fi

tmp="$portfile.tmp.$$"
awk -v h="$hash" '
  /^# fabric-src-hash: / { print "# fabric-src-hash: " h; next }
  { print }
' "$portfile" > "$tmp"

mv "$tmp" "$portfile"
echo "sync-fabric-overlay: fabric source dir = $fabric_dir"
echo "sync-fabric-overlay: fabric-src-hash -> $hash"
echo "sync-fabric-overlay: portfile updated -> $portfile"

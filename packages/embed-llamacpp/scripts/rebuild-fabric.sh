#!/usr/bin/env bash
# Inner-loop rebuild after editing fabric C++ in a LOCAL fabric checkout.
#
# Set QVAC_FABRIC_LOCAL_PATH (or QVAC_FABRIC_SRC_DIR) to point at a fabric
# working tree before running. The script:
#   1. bumps the overlay portfile's fabric-src-hash so vcpkg rebuilds the
#      qvac-fabric port from your local source,
#   2. regenerates CMake (which re-runs vcpkg manifest install),
#   3. builds + installs the addon.
#
# If QVAC_FABRIC_LOCAL_PATH is NOT set, the overlay portfile uses its
# pinned github fetch — there's nothing for this script to invalidate, and
# `bare-make build` alone is enough for addon-side edits.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
package_root="$(cd "$here/.." && pwd)"
cd "$package_root"

if [ -z "${QVAC_FABRIC_LOCAL_PATH:-}" ] && [ -n "${QVAC_FABRIC_SRC_DIR:-}" ]; then
  export QVAC_FABRIC_LOCAL_PATH="$QVAC_FABRIC_SRC_DIR"
fi

if [ -z "${QVAC_FABRIC_LOCAL_PATH:-}${QVAC_FABRIC_SRC_DIR:-}" ]; then
  default_fabric="$package_root/../../../qvac-fabric-llm.cpp"
  if [ -f "$default_fabric/CMakeLists.txt" ]; then
    export QVAC_FABRIC_LOCAL_PATH="$(cd "$default_fabric" && pwd)"
  else
    echo "rebuild-fabric: fabric checkout not found." >&2
    echo "  Set QVAC_FABRIC_LOCAL_PATH=/path/to/qvac-fabric-llm.cpp" >&2
    exit 1
  fi
fi

bash "$here/sync-fabric-overlay.sh"
bare-make generate
bare-make build
bare-make install
echo "rebuild-fabric: done"

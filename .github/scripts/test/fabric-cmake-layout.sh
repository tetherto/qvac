#!/usr/bin/env bash
# Configures a throwaway consumer against every @qvac/fabric install layout and
# asserts which runtime qvac_addon_fabric_layout() + include_bare_module() link:
# the meta package's own prebuilds/<host> when present (fabric <= 0.17, source
# builds, the CI overlay), otherwise the host's platform package wherever the
# package manager placed it.
#
# Usage: fabric-cmake-layout.sh <node_modules dir holding cmake-bare and cmake-npm>
set -euo pipefail

MODULES="$(cd "${1:?node_modules dir with cmake-bare and cmake-npm}" && pwd)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HOST="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')"
failures=0

write_meta() { # dir version [with-host]
  mkdir -p "$1/prebuilds/share"
  printf '{"name":"@qvac/fabric","version":"%s","addon":true}\n' "$2" > "$1/package.json"
  if [ "${3:-}" = with-host ]; then
    mkdir -p "$1/prebuilds/$HOST/qvac__fabric"
    : > "$1/prebuilds/$HOST/qvac__fabric.bare"
    : > "$1/prebuilds/$HOST/qvac__fabric/libggml-cpu.so"
  fi
}

write_slice() { # dir
  mkdir -p "$1/addon/prebuilds/$HOST/qvac__fabric"
  printf '{"name":"@qvac/fabric-%s","version":"0.18.0"}\n' "$HOST" > "$1/package.json"
  printf '{"name":"@qvac/fabric","version":"0.18.0","addon":true}\n' > "$1/addon/package.json"
  : > "$1/addon/prebuilds/$HOST/qvac__fabric.bare"
  : > "$1/addon/prebuilds/$HOST/qvac__fabric/libggml-cpu.so"
}

write_consumer() { # dir
  mkdir -p "$1"
  cat > "$1/CMakeLists.txt" <<EOF
cmake_minimum_required(VERSION 3.25)
find_package(cmake-bare REQUIRED PATHS "$MODULES/cmake-bare")
project(consumer NONE)
include("$REPO/cmake/qvac-addon/qvac-addon.cmake")
bare_target(host)
qvac_addon_fabric_layout("\${host}" "\${CMAKE_CURRENT_SOURCE_DIR}" spec wd prebuilds)
include_bare_module("\${spec}" fabric_target PREBUILD WORKING_DIRECTORY "\${wd}")
get_target_property(location \${fabric_target}_module IMPORTED_LOCATION)
file(GLOB backends "\${prebuilds}/\${host}/qvac__fabric/*.so")
message(STATUS "LAYOUT location=\${location}")
message(STATUS "LAYOUT backends=\${backends}")
EOF
}

# expect <case> <consumer dir> <expected location suffix> [warning]
expect() {
  local name="$1" dir="$2" suffix="$3" warning="${4:-}" out location backends
  out="$(cmake -S "$dir" -B "$dir/build" "-Dcmake-npm_DIR=$MODULES/cmake-npm" 2>&1)" || {
    echo "::error::$name: configure failed"; echo "$out"; failures=$((failures + 1)); return
  }
  location="$(printf '%s\n' "$out" | sed -n 's/^-- LAYOUT location=//p')"
  backends="$(printf '%s\n' "$out" | sed -n 's/^-- LAYOUT backends=//p')"
  case "$location" in
    *"$suffix") echo "ok   $name -> ${location#"$WORK"/}" ;;
    *) echo "::error::$name: linked $location, expected *$suffix"; failures=$((failures + 1)); return ;;
  esac
  if [ -n "$warning" ]; then
    if ! printf '%s\n' "$out" | grep -q "no fabric runtime for $HOST"; then
      echo "::error::$name: expected a missing-runtime warning"; failures=$((failures + 1))
    fi
    return
  fi
  if [ "$backends" != "$(dirname "$location")/qvac__fabric/libggml-cpu.so" ]; then
    echo "::error::$name: backends '$backends' are not next to the linked runtime"
    failures=$((failures + 1))
  fi
}

cd "$WORK"

write_consumer fat
write_meta fat/node_modules/@qvac/fabric 0.17.1 with-host
expect "fat meta (<= 0.17, source build)" fat "fat/node_modules/@qvac/fabric/prebuilds/$HOST/qvac__fabric.bare"

write_consumer overlay
write_meta overlay/node_modules/@qvac/fabric 0.18.0 with-host
write_slice "overlay/node_modules/@qvac/fabric-$HOST"
expect "overlay over a split install" overlay "overlay/node_modules/@qvac/fabric/prebuilds/$HOST/qvac__fabric.bare"

write_consumer pnpm
store="pnpm/node_modules/.pnpm/@qvac+fabric@0.18.0/node_modules/@qvac"
write_meta "$store/fabric" 0.18.0
write_slice "$store/fabric-$HOST"
mkdir -p pnpm/node_modules/@qvac
ln -s "$WORK/$store/fabric" pnpm/node_modules/@qvac/fabric
expect "pnpm isolated" pnpm "$store/fabric-$HOST/addon/prebuilds/$HOST/qvac__fabric.bare"

# Cross-built slices are never fabric's optional deps: the consumer depends on
# them directly, so pnpm links them into the consumer's node_modules only.
write_consumer pnpm-direct
meta_store="pnpm-direct/node_modules/.pnpm/@qvac+fabric@0.18.0/node_modules/@qvac"
slice_store="pnpm-direct/node_modules/.pnpm/@qvac+fabric-$HOST@0.18.0/node_modules/@qvac"
write_meta "$meta_store/fabric" 0.18.0
write_slice "$slice_store/fabric-$HOST"
mkdir -p pnpm-direct/node_modules/@qvac
ln -s "$WORK/$meta_store/fabric" pnpm-direct/node_modules/@qvac/fabric
ln -s "$WORK/$slice_store/fabric-$HOST" "pnpm-direct/node_modules/@qvac/fabric-$HOST"
expect "pnpm, slice as a direct dependency" pnpm-direct "pnpm-direct/node_modules/@qvac/fabric-$HOST/addon/prebuilds/$HOST/qvac__fabric.bare"

write_consumer hoisted
write_meta hoisted/node_modules/@qvac/fabric 0.18.0
write_slice "hoisted/node_modules/@qvac/fabric-$HOST"
expect "npm hoisted" hoisted "hoisted/node_modules/@qvac/fabric-$HOST/addon/prebuilds/$HOST/qvac__fabric.bare"

write_consumer nested
write_meta nested/node_modules/@qvac/fabric 0.18.0
write_slice "nested/node_modules/@qvac/fabric/node_modules/@qvac/fabric-$HOST"
expect "npm nested" nested "nested/node_modules/@qvac/fabric/node_modules/@qvac/fabric-$HOST/addon/prebuilds/$HOST/qvac__fabric.bare"

write_consumer missing
write_meta missing/node_modules/@qvac/fabric 0.18.0
expect "no runtime installed" missing "missing/node_modules/@qvac/fabric/prebuilds/$HOST/qvac__fabric.bare" warning

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures fabric CMake layout case(s) failed"
  exit 1
fi

#!/usr/bin/env bash
# Configures a throwaway consumer against every @qvac/fabric install layout and
# asserts which runtime qvac_addon_fabric_layout() + include_bare_module() link:
# the meta package's own prebuilds/<host> when present (fabric <= 0.17, source
# builds, the CI overlay), otherwise the host's platform package wherever the
# package manager placed it. Without either, configure must fail naming the
# package to install.
#
# Usage: fabric-cmake-layout.sh <node_modules dir holding cmake-bare and cmake-npm>
set -euo pipefail

MODULES="$(cd "${1:?node_modules dir with cmake-bare and cmake-npm}" && pwd)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HOST="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')"
# Layout boundaries, not the current release: the lookup never reads versions
# except to name the pin in its missing-runtime warning.
FAT_VERSION=0.17.1
SPLIT_VERSION=0.18.0
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

write_slice() { # dir [host, default: the runner's]
  local host="${2:-$HOST}"
  mkdir -p "$1/addon/prebuilds/$host/qvac__fabric"
  printf '{"name":"@qvac/fabric-%s","version":"%s"}\n' "$host" "$SPLIT_VERSION" > "$1/package.json"
  printf '{"name":"@qvac/fabric","version":"%s","addon":true}\n' "$SPLIT_VERSION" > "$1/addon/package.json"
  : > "$1/addon/prebuilds/$host/qvac__fabric.bare"
  : > "$1/addon/prebuilds/$host/qvac__fabric/libggml-cpu.so"
}

write_consumer() { # dir [cross-built host, default: the runner's]
  # include_bare_module() takes the host from the toolchain, so a cross-built
  # host checks the runtime in the prebuilds dir the lookup resolved instead.
  local host_line='bare_target(host)'
  local link_lines='include_bare_module("${spec}" fabric_target PREBUILD WORKING_DIRECTORY "${wd}")
get_target_property(location ${fabric_target}_module IMPORTED_LOCATION)'
  if [ -n "${2:-}" ]; then
    host_line="set(host $2)"
    link_lines='set(location "${prebuilds}/${host}/qvac__fabric.bare")'
  fi
  mkdir -p "$1"
  cat > "$1/CMakeLists.txt" <<EOF
cmake_minimum_required(VERSION 3.25)
find_package(cmake-bare REQUIRED PATHS "$MODULES/cmake-bare")
project(consumer NONE)
include("$REPO/cmake/qvac-addon/qvac-addon.cmake")
$host_line
qvac_addon_fabric_layout("\${host}" "\${CMAKE_CURRENT_SOURCE_DIR}" spec wd prebuilds)
$link_lines
file(GLOB backends "\${prebuilds}/\${host}/qvac__fabric/*.so")
message(STATUS "LAYOUT location=\${location}")
message(STATUS "LAYOUT backends=\${backends}")
EOF
}

configure() { # dir
  cmake -S "$1" -B "$1/build" "-Dcmake-npm_DIR=$MODULES/cmake-npm" 2>&1
}

# expect <case> <consumer dir> <expected location suffix>
expect() {
  local name="$1" dir="$2" suffix="$3" out location backends
  out="$(configure "$dir")" || {
    echo "::error::$name: configure failed"; echo "$out"; failures=$((failures + 1)); return
  }
  location="$(printf '%s\n' "$out" | sed -n 's/^-- LAYOUT location=//p')"
  backends="$(printf '%s\n' "$out" | sed -n 's/^-- LAYOUT backends=//p')"
  case "$location" in
    *"$suffix") echo "ok   $name -> ${location#"$WORK"/}" ;;
    *) echo "::error::$name: linked $location, expected *$suffix"; failures=$((failures + 1)); return ;;
  esac
  if [ "$backends" != "$(dirname "$location")/qvac__fabric/libggml-cpu.so" ]; then
    echo "::error::$name: backends '$backends' are not next to the linked runtime"
    failures=$((failures + 1))
  fi
}

# expect_fatal <case> <consumer dir> <text the error must contain>...
expect_fatal() {
  local name="$1" dir="$2" out text
  shift 2
  if out="$(configure "$dir")"; then
    echo "::error::$name: configure succeeded without a fabric runtime"; failures=$((failures + 1)); return
  fi
  # CMake wraps long error text; compare with whitespace runs collapsed.
  out="$(printf '%s' "$out" | tr -s '[:space:]' ' ')"
  for text in "$@"; do
    if ! printf '%s' "$out" | grep -qF -- "$text"; then
      echo "::error::$name: configure error lacks '$text'"; printf '%s\n' "$out"; failures=$((failures + 1)); return
    fi
  done
  echo "ok   $name -> configure error names $*"
}

cd "$WORK"

write_consumer fat
write_meta fat/node_modules/@qvac/fabric "$FAT_VERSION" with-host
expect "fat meta (<= 0.17, source build)" fat "fat/node_modules/@qvac/fabric/prebuilds/$HOST/qvac__fabric.bare"

write_consumer overlay
write_meta overlay/node_modules/@qvac/fabric "$SPLIT_VERSION" with-host
write_slice "overlay/node_modules/@qvac/fabric-$HOST"
expect "overlay over a split install" overlay "overlay/node_modules/@qvac/fabric/prebuilds/$HOST/qvac__fabric.bare"

write_consumer pnpm
store="pnpm/node_modules/.pnpm/@qvac+fabric@$SPLIT_VERSION/node_modules/@qvac"
write_meta "$store/fabric" "$SPLIT_VERSION"
write_slice "$store/fabric-$HOST"
mkdir -p pnpm/node_modules/@qvac
ln -s "$WORK/$store/fabric" pnpm/node_modules/@qvac/fabric
expect "pnpm isolated" pnpm "$store/fabric-$HOST/addon/prebuilds/$HOST/qvac__fabric.bare"

# Cross-built slices are never fabric's optional deps: the consumer depends on
# them directly, so pnpm links them into the consumer's node_modules only.
write_consumer pnpm-direct
meta_store="pnpm-direct/node_modules/.pnpm/@qvac+fabric@$SPLIT_VERSION/node_modules/@qvac"
slice_store="pnpm-direct/node_modules/.pnpm/@qvac+fabric-$HOST@$SPLIT_VERSION/node_modules/@qvac"
write_meta "$meta_store/fabric" "$SPLIT_VERSION"
write_slice "$slice_store/fabric-$HOST"
mkdir -p pnpm-direct/node_modules/@qvac
ln -s "$WORK/$meta_store/fabric" pnpm-direct/node_modules/@qvac/fabric
ln -s "$WORK/$slice_store/fabric-$HOST" "pnpm-direct/node_modules/@qvac/fabric-$HOST"
expect "pnpm, slice as a direct dependency" pnpm-direct "pnpm-direct/node_modules/@qvac/fabric-$HOST/addon/prebuilds/$HOST/qvac__fabric.bare"

write_consumer hoisted
write_meta hoisted/node_modules/@qvac/fabric "$SPLIT_VERSION"
write_slice "hoisted/node_modules/@qvac/fabric-$HOST"
expect "npm hoisted" hoisted "hoisted/node_modules/@qvac/fabric-$HOST/addon/prebuilds/$HOST/qvac__fabric.bare"

write_consumer nested
write_meta nested/node_modules/@qvac/fabric "$SPLIT_VERSION"
write_slice "nested/node_modules/@qvac/fabric/node_modules/@qvac/fabric-$HOST"
expect "npm nested" nested "nested/node_modules/@qvac/fabric/node_modules/@qvac/fabric-$HOST/addon/prebuilds/$HOST/qvac__fabric.bare"

# A cross-built leg on a CI runner: npm installed only the runner's slice, and
# the addon's exact-pinned devDependency supplies the target's.
write_consumer cross android-arm64
write_meta cross/node_modules/@qvac/fabric "$SPLIT_VERSION"
write_slice "cross/node_modules/@qvac/fabric-$HOST"
write_slice cross/node_modules/@qvac/fabric-android-arm64 android-arm64
expect "cross-built slice as a devDependency" cross "cross/node_modules/@qvac/fabric-android-arm64/addon/prebuilds/android-arm64/qvac__fabric.bare"

write_consumer missing
write_meta missing/node_modules/@qvac/fabric "$SPLIT_VERSION"
expect_fatal "desktop runtime not installed" missing \
  "no fabric runtime for $HOST" "@qvac/fabric-$HOST is not installed" "--omit=optional"

write_consumer missing-android android-arm64
write_meta missing-android/node_modules/@qvac/fabric "$SPLIT_VERSION"
write_slice "missing-android/node_modules/@qvac/fabric-$HOST"
expect_fatal "cross-built runtime not installed (android)" missing-android \
  "os/cpu filters; add \"@qvac/fabric-android-arm64\": \"^$SPLIT_VERSION\" to devDependencies."

write_consumer missing-ios ios-arm64-simulator
write_meta missing-ios/node_modules/@qvac/fabric "$SPLIT_VERSION"
expect_fatal "cross-built runtime not installed (ios)" missing-ios \
  "\"@qvac/fabric-ios\": \"^$SPLIT_VERSION\" to devDependencies"

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures fabric CMake layout case(s) failed"
  exit 1
fi

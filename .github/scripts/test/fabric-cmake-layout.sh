#!/usr/bin/env bash
# Configures a throwaway consumer against every @qvac/fabric install layout and
# asserts which runtime qvac_addon_fabric_layout() + include_bare_module() link:
# the host's platform package, @qvac/fabric-<suffix>, wherever the package
# manager placed it, with qvac__fabric-<suffix>.bare and its backends at
# prebuilds/<host>/. Without one, configure must fail naming the remedy.
#
# Usage: fabric-cmake-layout.sh <node_modules dir holding cmake-bare and cmake-npm>
set -euo pipefail

MODULES="$(cd "${1:?node_modules dir with cmake-bare and cmake-npm}" && pwd)"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HOST="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')"
VERSION=0.21.0
failures=0

suffix_of() { # host
  case "$1" in ios-*) echo ios ;; *) echo "$1" ;; esac
}

# The meta package: headers, a CMake package exposing the host helpers, and,
# for a source build, the runtime in its own prebuilds/<host>.
write_meta() { # dir [source-build|pre-0.21]
  local cmake="$1/prebuilds/share/qvac-fabric/cmake"
  mkdir -p "$cmake"
  printf '{"name":"@qvac/fabric","version":"%s"}\n' "$VERSION" > "$1/package.json"
  if [ "${2:-}" = pre-0.21 ]; then
    : > "$cmake/qvac-fabricConfig.cmake"
    return
  fi
  cp "$REPO/packages/fabric/cmake/qvac-fabric-hosts.cmake" "$cmake/"
  printf 'include("${CMAKE_CURRENT_LIST_DIR}/qvac-fabric-hosts.cmake")\n' > "$cmake/qvac-fabricConfig.cmake"
  if [ "${2:-}" = source-build ]; then
    local module="qvac__fabric-$(suffix_of "$HOST")"
    mkdir -p "$1/prebuilds/$HOST/$module"
    : > "$1/prebuilds/$HOST/$module.bare"
    : > "$1/prebuilds/$HOST/$module/libggml-cpu.so"
  fi
}

write_slice() { # dir [host, default: the runner's]
  local host="${2:-$HOST}" suffix module
  suffix="$(suffix_of "$host")"
  module="qvac__fabric-$suffix"
  mkdir -p "$1/prebuilds/$host/$module"
  printf '{"name":"@qvac/fabric-%s","version":"%s","addon":true}\n' "$suffix" "$VERSION" > "$1/package.json"
  printf 'module.exports = require.addon()\n' > "$1/index.js"
  : > "$1/prebuilds/$host/$module.bare"
  : > "$1/prebuilds/$host/$module/libggml-cpu.so"
}

write_consumer() { # dir [cross-built host, default: the runner's]
  # include_bare_module() takes the host from the toolchain, so a cross-built
  # host checks the runtime in the prebuilds dir the lookup resolved instead.
  local host_line='bare_target(host)'
  local link_lines='include_bare_module("${spec}" fabric_target PREBUILD WORKING_DIRECTORY "${wd}")
get_target_property(location ${fabric_target}_module IMPORTED_LOCATION)'
  if [ -n "${2:-}" ]; then
    host_line="set(host $2)"
    link_lines='set(location "${prebuilds}/${host}/${module}.bare")'
  fi
  mkdir -p "$1"
  cat > "$1/CMakeLists.txt" <<EOF
cmake_minimum_required(VERSION 3.25)
find_package(cmake-bare REQUIRED PATHS "$MODULES/cmake-bare")
project(consumer NONE)
include("$REPO/cmake/qvac-addon/qvac-addon.cmake")
set(qvac-fabric_DIR "\${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/fabric/prebuilds/share/qvac-fabric/cmake")
find_package(qvac-fabric CONFIG REQUIRED)
$host_line
qvac_addon_fabric_layout("\${host}" "\${CMAKE_CURRENT_SOURCE_DIR}" spec wd prebuilds)
qvac_fabric_module_name("\${host}" module)
$link_lines
file(GLOB backends "\${prebuilds}/\${host}/\${module}/*.so")
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
  if [ "$backends" != "${location%.bare}/libggml-cpu.so" ]; then
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

MODULE="qvac__fabric-$(suffix_of "$HOST")"
cd "$WORK"

# `npm run build` in packages/fabric ends with `npm run link:platform`, which
# nests the platform package in the meta's own node_modules.
write_consumer source
write_meta source/node_modules/@qvac/fabric source-build
write_slice "source/node_modules/@qvac/fabric/node_modules/@qvac/fabric-$HOST"
expect "linked source build" source \
  "source/node_modules/@qvac/fabric/node_modules/@qvac/fabric-$HOST/prebuilds/$HOST/$MODULE.bare"

write_consumer pnpm
store="pnpm/node_modules/.pnpm/@qvac+fabric@$VERSION/node_modules/@qvac"
write_meta "$store/fabric"
write_slice "$store/fabric-$HOST"
mkdir -p pnpm/node_modules/@qvac
ln -s "$WORK/$store/fabric" pnpm/node_modules/@qvac/fabric
expect "pnpm isolated" pnpm "$store/fabric-$HOST/prebuilds/$HOST/$MODULE.bare"

# Consumers also declare the platform packages, so pnpm links them into the
# consumer's node_modules too.
write_consumer pnpm-direct
meta_store="pnpm-direct/node_modules/.pnpm/@qvac+fabric@$VERSION/node_modules/@qvac"
slice_store="pnpm-direct/node_modules/.pnpm/@qvac+fabric-$HOST@$VERSION/node_modules/@qvac"
write_meta "$meta_store/fabric"
write_slice "$slice_store/fabric-$HOST"
mkdir -p pnpm-direct/node_modules/@qvac
ln -s "$WORK/$meta_store/fabric" pnpm-direct/node_modules/@qvac/fabric
ln -s "$WORK/$slice_store/fabric-$HOST" "pnpm-direct/node_modules/@qvac/fabric-$HOST"
expect "pnpm, slice as a direct dependency" pnpm-direct \
  "pnpm-direct/node_modules/@qvac/fabric-$HOST/prebuilds/$HOST/$MODULE.bare"

write_consumer hoisted
write_meta hoisted/node_modules/@qvac/fabric
write_slice "hoisted/node_modules/@qvac/fabric-$HOST"
expect "npm hoisted" hoisted "hoisted/node_modules/@qvac/fabric-$HOST/prebuilds/$HOST/$MODULE.bare"

write_consumer nested
write_meta nested/node_modules/@qvac/fabric
write_slice "nested/node_modules/@qvac/fabric/node_modules/@qvac/fabric-$HOST"
expect "npm nested" nested \
  "nested/node_modules/@qvac/fabric/node_modules/@qvac/fabric-$HOST/prebuilds/$HOST/$MODULE.bare"

# A cross-built leg on a CI runner: npm installed only the runner's slice, and
# the addon's exact-pinned devDependency supplies the target's.
write_consumer cross android-arm64
write_meta cross/node_modules/@qvac/fabric
write_slice "cross/node_modules/@qvac/fabric-$HOST"
write_slice cross/node_modules/@qvac/fabric-android-arm64 android-arm64
expect "cross-built slice as a devDependency" cross \
  "cross/node_modules/@qvac/fabric-android-arm64/prebuilds/android-arm64/qvac__fabric-android-arm64.bare"

write_consumer cross-ios ios-arm64-simulator
write_meta cross-ios/node_modules/@qvac/fabric
write_slice cross-ios/node_modules/@qvac/fabric-ios ios-arm64-simulator
expect "every iOS host in @qvac/fabric-ios" cross-ios \
  "cross-ios/node_modules/@qvac/fabric-ios/prebuilds/ios-arm64-simulator/qvac__fabric-ios.bare"

write_consumer unlinked
write_meta unlinked/node_modules/@qvac/fabric source-build
expect_fatal "source build not linked" unlinked \
  "no fabric runtime for $HOST" "npm run link:platform"

write_consumer missing
write_meta missing/node_modules/@qvac/fabric
expect_fatal "desktop runtime not installed" missing \
  "no fabric runtime for $HOST" "@qvac/fabric-$HOST is not installed" "--omit=optional"

write_consumer missing-android android-arm64
write_meta missing-android/node_modules/@qvac/fabric
write_slice "missing-android/node_modules/@qvac/fabric-$HOST"
expect_fatal "cross-built runtime not installed (android)" missing-android \
  "os/cpu filters; add \"@qvac/fabric-android-arm64\": \"$VERSION\" to devDependencies."

write_consumer missing-ios ios-arm64-simulator
write_meta missing-ios/node_modules/@qvac/fabric
expect_fatal "cross-built runtime not installed (ios)" missing-ios \
  "\"@qvac/fabric-ios\": \"$VERSION\" to devDependencies"

write_consumer old
write_meta old/node_modules/@qvac/fabric pre-0.21
expect_fatal "fabric without platform-package helpers" old "@qvac/fabric >= 0.21"

if [ "$failures" -gt 0 ]; then
  echo "::error::$failures fabric CMake layout case(s) failed"
  exit 1
fi

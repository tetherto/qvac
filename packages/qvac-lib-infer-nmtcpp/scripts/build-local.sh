#!/bin/bash
set -e

echo "======================================"
echo "Local Build Script for qvac-lib-infer-nmtcpp"
echo "======================================"
echo ""

# Navigate to project directory
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && { git rev-parse --show-toplevel 2>/dev/null || pwd; })"
cd "$REPO_ROOT"

CLOG_CMAKE="third-party/bergamot-translator/3rd_party/marian-dev/src/3rd_party/ruy/third_party/cpuinfo/deps/clog/CMakeLists.txt"
if [ -f "$CLOG_CMAKE" ]; then
  echo "Found clog CMakeLists.txt, applying fix..."
  sed -i.bak 's/CMAKE_MINIMUM_REQUIRED(VERSION 3\.1/CMAKE_MINIMUM_REQUIRED(VERSION 3.5/' "$CLOG_CMAKE"
  echo "Verification:"
  head -n 3 "$CLOG_CMAKE"
else
  echo "Clog CMakeLists.txt not found at $CLOG_CMAKE (may not be needed for this platform)"
fi

SENTENCEPIECE_CMAKE="third-party/bergamot-translator/3rd_party/marian-dev/src/3rd_party/sentencepiece/CMakeLists.txt"
if [ -f "$SENTENCEPIECE_CMAKE" ]; then
  echo "Found sentencepiece CMakeLists.txt, applying CMake version fix..."
  sed -i.bak 's/cmake_minimum_required(VERSION 3\.1/cmake_minimum_required(VERSION 3.5/' "$SENTENCEPIECE_CMAKE"
  echo "Verification:"
  head -n 3 "$SENTENCEPIECE_CMAKE"
else
  echo "sentencepiece CMakeLists.txt not found at $SENTENCEPIECE_CMAKE"
fi

echo "Replacing std::result_of with std::invoke_result for C++17/C++20 compatibility..."

# Fix CLI/App.hpp - has complex nested decltype patterns
# Original: std::result_of<decltype (&App::_parse_arg)(App, Args...)>::type
# Target:   std::invoke_result<decltype (&App::_parse_arg), App, Args...>::type
CLI_APP_HPP="third-party/bergamot-translator/3rd_party/marian-dev/src/3rd_party/CLI/App.hpp"
if [ -f "$CLI_APP_HPP" ]; then
  echo "Fixing CLI/App.hpp..."
  # Fix _parse_arg pattern
  sed -i.bak 's/std::result_of<decltype (\&App::_parse_arg)(App, Args\.\.\.)>/std::invoke_result<decltype (\&App::_parse_arg), App, Args...>/g' "$CLI_APP_HPP"
  # Fix _parse_subcommand pattern
  sed -i.bak2 's/std::result_of<decltype (\&App::_parse_subcommand)(App, Args\.\.\.)>/std::invoke_result<decltype (\&App::_parse_subcommand), App, Args...>/g' "$CLI_APP_HPP"
  echo "Verification:"
  grep -n "invoke_result\|result_of" "$CLI_APP_HPP" | head -5 || echo "No result_of found (good)"
fi

# Fix threadpool.h - simpler pattern
# Original: std::result_of<F(Args...)>
# Target:   std::invoke_result<F, Args...>
THREADPOOL_H="third-party/bergamot-translator/3rd_party/marian-dev/src/3rd_party/threadpool.h"
if [ -f "$THREADPOOL_H" ]; then
  echo "Fixing threadpool.h..."
  sed -i.bak 's/std::result_of<F(Args\.\.\.)>/std::invoke_result<F, Args...>/g' "$THREADPOOL_H"
  echo "Verification:"
  grep -n "invoke_result\|result_of" "$THREADPOOL_H" | head -5 || echo "No result_of found (good)"
fi

echo "std::result_of fixes applied"

echo "Applying iOS set_xcode_property fix..."
SENTENCEPIECE_CMAKE="third-party/bergamot-translator/3rd_party/marian-dev/src/3rd_party/sentencepiece/src/CMakeLists.txt"
if [ -f "$SENTENCEPIECE_CMAKE" ]; then
  echo "Found sentencepiece CMakeLists.txt, applying fix..."
  # Comment out set_xcode_property calls that require a function not defined
  sed -i.bak '/set_xcode_property/s/^/# /' "$SENTENCEPIECE_CMAKE"
  echo "Verification:"
  grep -A 2 "iOS" "$SENTENCEPIECE_CMAKE" | head -10 || echo "Pattern not found"
else
  echo "sentencepiece CMakeLists.txt not found at $SENTENCEPIECE_CMAKE"
fi
echo "iOS set_xcode_property fix applied"


echo "Removing -march=native from cpuinfo and marian-dev CMakeLists.txt..."

# Fix 1: Remove -march=native from marian-dev
MARIAN_CMAKE="third-party/bergamot-translator/3rd_party/marian-dev/CMakeLists.txt"
if [ -f "$MARIAN_CMAKE" ]; then
  echo "Fixing marian-dev CMakeLists.txt..."
  sed -i.bak3 's/-msse2//g' "$MARIAN_CMAKE"
  sed -i.bak4 's/-march=native//g' "$MARIAN_CMAKE"
  grep -n "march\|msse" "$MARIAN_CMAKE" | head -5 || echo "No x86-specific flags in marian-dev (good)"
fi

# Fix 2: Remove -march=native from cpuinfo (RUY dependency)
# cpuinfo's CMakeLists.txt adds -march=native which causes 'apple-m1' errors
# when cross-compiling x86_64 on ARM64 hosts
CPUINFO_CMAKE="third-party/bergamot-translator/3rd_party/marian-dev/src/3rd_party/ruy/third_party/cpuinfo/CMakeLists.txt"
if [ -f "$CPUINFO_CMAKE" ]; then
  echo "Fixing cpuinfo CMakeLists.txt..."
  sed -i.bak5 's/-march=native//g' "$CPUINFO_CMAKE"
  grep -n "march" "$CPUINFO_CMAKE" | head -5 || echo "No march flags in cpuinfo (good)"
else
  echo "cpuinfo CMakeLists.txt not found (may not be needed)"
fi

echo "-march=native removal complete"

echo "Step 1: Applying C++17/C++20 compatibility patches..."
echo "--------------------------------------"

echo ""
echo "Step 2: Installing dependencies..."
echo "--------------------------------------"
npm install

echo ""
echo "Step 3: Creating Bergamot configuration..."
echo "--------------------------------------"
# Parse minimal --platform/-p and --arch/-a from CLI to mirror CI behavior
PLATFORM=""
ARCH=""
BUILD_DIR=""
ARGS=("$@")
for ((i=0; i<${#ARGS[@]}; i++)); do
  case "${ARGS[$i]}" in
    -p|--platform)
      PLATFORM="${ARGS[$((i+1))]}";;
    -a|--arch)
      ARCH="${ARGS[$((i+1))]}";;
    --build)
      BUILD_DIR="${ARGS[$((i+1))]}";;
  esac
done

# Create config.cmake similar to CI prebuild workflow
{
  echo "set(USE_BERGAMOT ON CACHE BOOL \"Enable Bergamot backend support\" FORCE)"

  # Enable INTGEMM only on x86/x64 desktop targets
  if { [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "win32" ]; } && { [ "$ARCH" = "x64" ] || [ "$ARCH" = "x86" ]; }; then
    echo "set(USE_INTGEMM ON CACHE BOOL \"Use INTGEMM for int8 quantized models\" FORCE)"
  fi

  # Avoid -march=native causing 'apple-m3' when cross-compiling x64 on ARM macOS runners
  if [ "$ARCH" = "x64" ] && { [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "darwin" ] || [ "$PLATFORM" = "ios" ]; }; then
    echo "set(BUILD_ARCH x86-64-v2 CACHE STRING \"Target CPU architecture\" FORCE)"
  fi
} > config.cmake
cat config.cmake

echo ""
echo "Step 4: Generating build files..."
echo "--------------------------------------"
if [ "$#" -gt 0 ]; then
  echo "Passing arguments to 'bare-make generate': $*"
fi
if [ -n "$BUILD_DIR" ]; then
  echo "Detected build directory: $BUILD_DIR"
fi

bare-make generate "${ARGS[@]}"
if [ -n "$BUILD_DIR" ]; then
  bare-make build --build "$BUILD_DIR"
  bare-make install --build "$BUILD_DIR"
else
  bare-make build
  bare-make install
fi

echo ""
echo "======================================"
echo "✓ Build completed successfully!"
echo "======================================"

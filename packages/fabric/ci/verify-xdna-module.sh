#!/usr/bin/env bash
# main's reusable-prebuilds "Verify Linux x64 XDNA module": the XDNA module links XRT's C++ API, so it is the one backend
# built against the system libstdc++ instead of libc++, and it loads its NPU kernels from its own directory.
set -euo pipefail
shopt -s nullglob globstar
xdna_modules=(prebuilds/linux-x64/**/*ggml-xdna.so)
if [ "${#xdna_modules[@]}" -ne 1 ]; then
  echo "::error::expected one Linux x64 XDNA module, found ${#xdna_modules[@]}"
  exit 1
fi
module="${xdna_modules[0]}"
dir="$(dirname "$module")"
ls -l "$module"
dyn="$(readelf -d "$module")"
echo "$dyn" | grep -E 'NEEDED|RUNPATH|RPATH'
for lib in libstdc++.so.6 libxrt_coreutil.so.2; do
  echo "$dyn" | grep -q "Shared library: \[$lib\]" || { echo "::error::$module does not need $lib"; exit 1; }
done
if echo "$dyn" | grep -q -E 'Shared library: \[libc\+\+(abi)?\.so'; then
  echo "::error::$module needs libc++; it must use libstdc++ only"
  exit 1
fi
if nm -D --undefined-only "$module" | grep -q -E ' (ggml|gguf)_'; then
  echo "::error::$module has undefined ggml_/gguf_ symbols; it must embed its own ggml-base"
  exit 1
fi
for design in fused_layer gemv_n32_r4_c8; do
  kernels=("$dir"/${design}_*.xclbin)
  if [ "${#kernels[@]}" -eq 0 ]; then
    echo "::error::no ${design}_*.xclbin next to $module"
    exit 1
  fi
done
instructions=("$dir"/*.insts.bin)
if [ "${#instructions[@]}" -eq 0 ]; then
  echo "::error::no *.insts.bin next to $module"
  exit 1
fi
ls -l "$dir"/*.xclbin "${instructions[@]}"

#!/usr/bin/env bash
# Verify which GGML backends and BLAS paths are actually shipped with @qvac/ocr-ggml.
#
# Unlike upstream EasyOcr-ggml (which builds ggml as a submodule and inspects
# build/third_party/ggml/...), this package consumes ggml from `qvac-fabric`
# via vcpkg. The runtime artefacts live under `prebuilds/<host>/qvac__ocr-ggml/`,
# bundled by `bare-make install`.
#
# Outputs four sections:
#   1. Shipped backend libraries — which `libggml-*.so` files were installed
#   2. Linked dependencies        — `ldd` on each, to spot system OpenBLAS /
#                                   Vulkan / OpenCL libraries that they pull in
#   3. Compile-time markers       — `strings` greps for canonical symbols:
#                                     llamafile_sgemm    -> tinyBLAS engaged
#                                     cblas_sgemm        -> external BLAS path
#                                     vkCreateInstance   -> Vulkan backend
#                                     clCreateContext    -> OpenCL backend
#   4. vcpkg port summary         — versions of the ggml-providing port
#
# Headline interpretation:
#   - llamafile/tinyBLAS is ENGAGED iff `llamafile_sgemm` appears in section 3.
#   - External BLAS is REGISTERED iff `libggml-blas.so` is shipped in section 1
#     AND `cblas_sgemm` appears in section 3. Whether it is *actually used* at
#     runtime depends on whether Pipeline routes through the scheduler API,
#     which (today, mirroring upstream) it does not — so external BLAS is
#     usually REGISTERED but UNUSED.
#   - Vulkan / OpenCL are AVAILABLE iff the corresponding `libggml-vulkan.so`
#     / `libggml-opencl.so` is present AND the matching symbols appear. They
#     are only EXERCISED if the addon is loaded with `useGPU=true` and the
#     host system has matching device drivers.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# bare-module install path: prebuilds/<host>/qvac__ocr-ggml/
# `host` is set by cmake-bare based on the runtime platform; on x64 Linux it
# is `linux-x64`, on Apple Silicon `darwin-arm64`, etc.
HOST_GUESS="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -E 's/^x86_64$/x64/;s/^aarch64$/arm64/')"
BACKENDS_DIR="${BACKENDS_DIR:-${REPO_ROOT}/prebuilds/${HOST_GUESS}/qvac__ocr-ggml}"

print_section() {
    echo
    echo "============================================================"
    echo "  $1"
    echo "============================================================"
}

if [[ ! -d "${BACKENDS_DIR}" ]]; then
    echo "error: backends directory not found: ${BACKENDS_DIR}" >&2
    echo "" >&2
    echo "Run 'bare-make generate && bare-make build && bare-make install'" >&2
    echo "first, or override BACKENDS_DIR=/abs/path/to/prebuilds/<host>/qvac__ocr-ggml" >&2
    exit 1
fi

# ----------------------------------------------------------------------------
# 1. Shipped backend libraries
# ----------------------------------------------------------------------------
print_section "1. Shipped backend libraries"
echo "Looking in: ${BACKENDS_DIR}"
echo
ls -lh "${BACKENDS_DIR}"/libggml-*.so 2>/dev/null || \
    echo "(no libggml-*.so files — only the static CPU backend was linked)"

# Also show the bare addon itself
echo
echo "Addon module:"
ls -lh "${BACKENDS_DIR}"/*.bare 2>/dev/null || \
    echo "(no .bare module — did 'bare-make install' run?)"

# ----------------------------------------------------------------------------
# 2. Linked dependencies (ldd)
# ----------------------------------------------------------------------------
print_section "2. Linked dependencies (ldd)"
for lib in "${BACKENDS_DIR}"/libggml-*.so "${BACKENDS_DIR}"/*.bare; do
    [[ -e "${lib}" ]] || continue
    echo
    echo "--- ${lib##*/} ---"
    ldd "${lib}" 2>/dev/null | head -25 || true
done

# ----------------------------------------------------------------------------
# 3. Compile-time markers (strings)
# ----------------------------------------------------------------------------
print_section "3. Compile-time markers"

check_symbol() {
    local label="$1"
    local pattern="$2"
    shift 2
    local found=0
    for lib in "$@"; do
        [[ -e "${lib}" ]] || continue
        if strings "${lib}" 2>/dev/null | grep -q -E "${pattern}"; then
            printf "  [%-6s] %s  %s\n" "FOUND" "${label}" "in ${lib##*/}"
            found=1
        fi
    done
    if [[ ${found} -eq 0 ]]; then
        printf "  [%-6s] %s\n" "ABSENT" "${label}"
    fi
}

ALL_LIBS=("${BACKENDS_DIR}"/libggml-*.so "${BACKENDS_DIR}"/*.bare)
check_symbol "tinyBLAS (GGML_LLAMAFILE=ON)" "llamafile_sgemm"  "${ALL_LIBS[@]}"
check_symbol "external BLAS (GGML_BLAS)"    "cblas_sgemm"      "${ALL_LIBS[@]}"
check_symbol "Vulkan backend"               "vkCreateInstance" "${ALL_LIBS[@]}"
check_symbol "OpenCL backend"               "clCreateContext"  "${ALL_LIBS[@]}"
check_symbol "CUDA backend"                 "cudaMalloc"       "${ALL_LIBS[@]}"
check_symbol "Metal backend"                "MTLCreateSystemDefaultDevice" "${ALL_LIBS[@]}"

# ----------------------------------------------------------------------------
# 4. vcpkg port summary
# ----------------------------------------------------------------------------
print_section "4. vcpkg port summary (ggml provider)"
VCPKG_LOCK="${REPO_ROOT}/vcpkg-configuration.json"
VCPKG_MANIFEST="${REPO_ROOT}/vcpkg.json"
echo "manifest:         ${VCPKG_MANIFEST}"
echo "configuration:    ${VCPKG_LOCK}"
echo
echo "Declared ggml provider (from vcpkg.json):"
grep -A 4 'qvac-fabric' "${VCPKG_MANIFEST}" 2>/dev/null | sed 's/^/  /' || \
    echo "  (vcpkg.json not readable)"

echo
echo "Tip: to confirm the exact version that built, look in"
echo "     build/_vcpkg/vcpkg/info/qvac-fabric_*.list"
echo

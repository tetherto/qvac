#!/usr/bin/env bash
# Verify which GGML backends and BLAS paths are actually shipped with @qvac/ocr-ggml.
#
# Unlike upstream EasyOcr-ggml (which builds ggml as a submodule and inspects
# build/third_party/ggml/...), this package consumes ggml from the
# `@qvac/fabric` npm runtime. The runtime artefacts live under
# `node_modules/@qvac/fabric/prebuilds/<host>/qvac__fabric/`.
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

# Fabric backend path: node_modules/@qvac/fabric/prebuilds/<host>/qvac__fabric/
# `host` is set by cmake-bare based on the runtime platform; on x64 Linux it
# is `linux-x64`, on Apple Silicon `darwin-arm64`, etc.
HOST_GUESS="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -E 's/^x86_64$/x64/;s/^aarch64$/arm64/')"
BACKENDS_DIR="${BACKENDS_DIR:-${REPO_ROOT}/node_modules/@qvac/fabric/prebuilds/${HOST_GUESS}/qvac__fabric}"

print_section() {
    echo
    echo "============================================================"
    echo "  $1"
    echo "============================================================"
}

if [[ ! -d "${BACKENDS_DIR}" ]]; then
    echo "error: backends directory not found: ${BACKENDS_DIR}" >&2
    echo "" >&2
    echo "Run 'npm install' to install @qvac/fabric," >&2
    echo "or override BACKENDS_DIR=/abs/path/to/@qvac/fabric/prebuilds/<host>/qvac__fabric" >&2
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

# Also show Fabric's shared bare runtime.
echo
echo "Fabric runtime:"
ls -lh "${BACKENDS_DIR}"/../qvac__fabric.bare 2>/dev/null || \
    echo "(no qvac__fabric.bare module — did 'npm install' run?)"

# ----------------------------------------------------------------------------
# 2. Linked dependencies (ldd)
# ----------------------------------------------------------------------------
print_section "2. Linked dependencies (ldd)"
for lib in "${BACKENDS_DIR}"/libggml-*.so "${BACKENDS_DIR}"/../qvac__fabric.bare; do
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

ALL_LIBS=("${BACKENDS_DIR}"/libggml-*.so "${BACKENDS_DIR}"/../qvac__fabric.bare)
check_symbol "tinyBLAS (GGML_LLAMAFILE=ON)" "llamafile_sgemm"  "${ALL_LIBS[@]}"
check_symbol "external BLAS (GGML_BLAS)"    "cblas_sgemm"      "${ALL_LIBS[@]}"
check_symbol "Vulkan backend"               "vkCreateInstance" "${ALL_LIBS[@]}"
check_symbol "OpenCL backend"               "clCreateContext"  "${ALL_LIBS[@]}"
check_symbol "CUDA backend"                 "cudaMalloc"       "${ALL_LIBS[@]}"
check_symbol "Metal backend"                "MTLCreateSystemDefaultDevice" "${ALL_LIBS[@]}"

# ----------------------------------------------------------------------------
# 4. npm runtime summary
# ----------------------------------------------------------------------------
print_section "4. @qvac/fabric runtime summary"
PACKAGE_MANIFEST="${REPO_ROOT}/package.json"
FABRIC_MANIFEST="${REPO_ROOT}/node_modules/@qvac/fabric/package.json"
echo "consumer manifest: ${PACKAGE_MANIFEST}"
echo "fabric manifest:   ${FABRIC_MANIFEST}"
echo
echo "Declared Fabric dependency (from package.json):"
grep -A 1 '"@qvac/fabric"' "${PACKAGE_MANIFEST}" 2>/dev/null | sed 's/^/  /' || \
    echo "  (package.json not readable)"

echo
echo "Installed Fabric version:"
grep '"version"' "${FABRIC_MANIFEST}" 2>/dev/null | head -1 | sed 's/^/  /' || \
    echo "  (@qvac/fabric is not installed)"
echo

# ggml vcpkg overlay port
#
# Builds the ggml tensor library from tetherto/qvac-ext-ggml.
# Fork of leejet/ggml (v0.12.0) carrying the reviewed Metal/video kernels
# (IM2COL_3D, PAD, fused Flux RoPE, direct conv2d) plus the merged LTX compute
# set, pinned from the 2026-06-06 branch (see the REF block below for specifics).
#
# Without these kernels the Metal backend aborts mid-video inference with
# `unsupported op 'IM2COL_3D'` and the test-backend-ops support/test matrix
# advertises invalid IM2COL_3D combos that hit CPU GGML_ASSERTs.
#
# Installed artefacts:
#   include/ggml.h  (+ other ggml public headers)
#   lib/libggml.a, lib/libggml-base.a, lib/libggml-cpu.a, ...
#   share/ggml/      (CMake package config)
#
# GPU backend selection via vcpkg features:
#   metal  -> GGML_METAL=ON  (macOS/iOS, default-feature on Apple platforms)
#   vulkan -> GGML_VULKAN=ON
#   cuda   -> GGML_CUDA=ON
#   opencl -> GGML_OPENCL=ON

# Pulls from the tetherto/qvac-ext-ggml GitHub branch 2026-07-03
# (REF pinned to that branch's tip commit for reproducibility).
#
# ea8cf04 extends the size-reduction shader filter to also replace unused
# Vulkan training, backward, loss, and outer-product shader payloads with
# no-op bodies.
#
# 9089ce6 replaced unused TQ1/TQ2/MXFP4/NVFP4 Vulkan shader payloads with
# no-op bodies.
#
# b0d6be4 was the tip of 2026-07-03 after merging the size-reduction change
# that defaults Adreno Vulkan shaders to Android-only and replaces unused
# TBQ/PQ shader payloads with no-op bodies.
#
# b84554ae was the tip of 2026-07-03 - a clone of the
# 2026-06-06-on-fabric-ggml-adreno-teardown branch. On top of leejet/ggml
# v0.12.0 it carries the full merged compute set: the reviewed Metal/video
# kernels (IM2COL_3D/PAD, fused Flux RoPE, direct conv2d), the coopmat1
# flash-attn f32-accumulation fixes, the ggml_graph_leaf/leafs/n_leafs public
# API export, and the ggml_conv_1d/dw im2col-type fix (derive from a->type like
# conv_2d) so F32 conv weights (e.g. LTX audio VAE) flow through the F32 path
# instead of aborting on the CPU im2col_f16 F16 assert.
#
# This fabric-based branch also preserves qvac-fabric-llm.cpp's Adreno OpenCL
# Q4_0 preallocated transpose-buffer path and serialized OpenCL SOA tensor
# uploads, and cherry-picks e90151ab (ggml-opencl: release sub-buffers before
# parent buffers on teardown) to fix the Adreno/QCOM Scudo "invalid chunk state"
# abort on repeated Q4_0 load/unload cycles.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF ea8cf042a3934c04b935331243c9ef8b5b4ff84e
    SHA512 08fc8cfe6f1064d79325e90bfacfbcd18e356a75d29fea68134d1e77e652ab275efa62b72949145d41a7ac9480181a31d39bc5ebcdbbb698432cc3cc9e1dbe51
)

# --- GPU feature flags ---
set(GGML_METAL  OFF)
set(GGML_VULKAN OFF)
set(GGML_CUDA   OFF)
set(GGML_OPENCL OFF)

if("metal" IN_LIST FEATURES)
    set(GGML_METAL ON)
endif()

if("vulkan" IN_LIST FEATURES)
    set(GGML_VULKAN ON)
endif()

set(GGML_CUDA_COMPILER_OPTION "")

if("cuda" IN_LIST FEATURES)
    set(GGML_CUDA ON)
    # Locate nvcc explicitly - /usr/local/cuda/bin may not be on the PATH that
    # vcpkg's isolated cmake process inherits.
    find_program(NVCC_EXECUTABLE nvcc
        PATHS /usr/local/cuda/bin /usr/local/cuda-12.8/bin
        NO_DEFAULT_PATH
    )
    if(NOT NVCC_EXECUTABLE)
        find_program(NVCC_EXECUTABLE nvcc REQUIRED)
    endif()
    set(GGML_CUDA_COMPILER_OPTION "-DCMAKE_CUDA_COMPILER=${NVCC_EXECUTABLE}")
    message(STATUS "CUDA compiler: ${NVCC_EXECUTABLE}")
endif()

if("opencl" IN_LIST FEATURES)
    set(GGML_OPENCL ON)
endif()

# --- Android: fetch NDK-matched Vulkan C++ headers ---
# The NDK ships vulkan/vulkan_core.h (C) but not vulkan/vulkan.hpp (C++).
# Rather than pulling the vcpkg vulkan-headers package (which may be a
# different version), we detect the NDK's exact Vulkan version and download
# the matching C++ headers from KhronosGroup/Vulkan-Headers.
if(VCPKG_TARGET_IS_ANDROID AND "vulkan" IN_LIST FEATURES)
    include(${CMAKE_CURRENT_LIST_DIR}/android-vulkan-version.cmake)
    detect_ndk_vulkan_version()
    message(STATUS "NDK Vulkan version: ${vulkan_version}")

    file(DOWNLOAD
        "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v${vulkan_version}.tar.gz"
        "${SOURCE_PATH}/vulkan-hpp-${vulkan_version}.tar.gz"
        TLS_VERIFY ON
    )
    file(ARCHIVE_EXTRACT
        INPUT "${SOURCE_PATH}/vulkan-hpp-${vulkan_version}.tar.gz"
        DESTINATION "${SOURCE_PATH}"
        PATTERNS "*.hpp"
    )
    # ggml_add_backend_library adds target_include_directories(${backend} PRIVATE ..)
    # which resolves to src/ for backends under src/ggml-vulkan/.  Placing the
    # headers at src/vulkan/*.hpp makes #include <vulkan/vulkan.hpp> resolve.
    file(COPY "${SOURCE_PATH}/Vulkan-Headers-${vulkan_version}/include/"
         DESTINATION "${SOURCE_PATH}/src/")
endif()

# --- Platform options ---
set(PLATFORM_OPTIONS)

if(VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
endif()

# Hybrid backend mode for Android: GPU backends (Vulkan, OpenCL) are MODULE
# .so files loaded at runtime via dlopen - no libOpenCL.so NEEDED dependency.
# The CPU backend is statically linked (GGML_CPU_STATIC) so that SD can call
# ggml_set_f32, ggml_backend_cpu_init, etc. directly at link time.
if(VCPKG_TARGET_IS_ANDROID)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BACKEND_DL=ON
        -DGGML_CPU_STATIC=ON
        -DGGML_VULKAN_DISABLE_COOPMAT=ON
        -DGGML_VULKAN_DISABLE_COOPMAT2=ON
    )
endif()

# --- Configure & build ---
# Only build Release. The fabric branch installs its CMake package config once
# under share/ggml, matching the release-only consumers in this package family.
set(VCPKG_BUILD_TYPE release)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DBUILD_SHARED_LIBS=OFF
        -DGGML_NATIVE=OFF
        -DGGML_CCACHE=OFF
        -DGGML_OPENMP=OFF
        -DGGML_LLAMAFILE=OFF
        -DGGML_BUILD_TESTS=OFF
        -DGGML_BUILD_EXAMPLES=OFF
        -DGGML_METAL=${GGML_METAL}
        -DGGML_VULKAN=${GGML_VULKAN}
        -DGGML_CUDA=${GGML_CUDA}
        -DGGML_OPENCL=${GGML_OPENCL}
        -DGGML_MAX_NAME=128  # stable-diffusion.cpp requires >= 128
        ${GGML_CUDA_COMPILER_OPTION}
        ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

# Install DL backend .so files for Android.  ggml builds each backend as a
# MODULE target but does NOT install them via cmake install().
if(VCPKG_TARGET_IS_ANDROID)
    file(GLOB _backend_sos
        "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/bin/libqvac-diffusion-ggml-*.so"
        "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/bin/libqvac-ggml-*.so"
        "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/bin/libggml-*.so"
    )
    if(_backend_sos)
        file(INSTALL ${_backend_sos} DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
    endif()
endif()

# Fix up the CMake package config installed by ggml's own build system.
vcpkg_cmake_config_fixup(PACKAGE_NAME ggml CONFIG_PATH share/ggml)

# ggml installs a .pc to share/pkgconfig; move it to lib/pkgconfig and fix
# absolute paths so vcpkg's post-build checks pass.
if(EXISTS "${CURRENT_PACKAGES_DIR}/share/pkgconfig/ggml.pc")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/lib/pkgconfig")
    file(RENAME "${CURRENT_PACKAGES_DIR}/share/pkgconfig/ggml.pc"
                "${CURRENT_PACKAGES_DIR}/lib/pkgconfig/ggml.pc")
endif()
if(EXISTS "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig/ggml.pc")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig")
    file(RENAME "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig/ggml.pc"
                "${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig/ggml.pc")
endif()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/share/pkgconfig"
                    "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig")
vcpkg_fixup_pkgconfig()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

# DL backends are only built for release; debug build produces fewer binaries.
set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

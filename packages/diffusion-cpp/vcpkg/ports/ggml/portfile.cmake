# ggml vcpkg overlay port  (diffusion-cpp local override)
#
# WHY THIS OVERLAY EXISTS
#   The qvac-registry-vcpkg ggml port pins ggml-org/ggml@a8db410a, which is
#   ggml master without the Wan-required Metal ops. Wan 2.1 / 2.2 video
#   generation triggers IM2COL_3D and PAD-with-left-padding inside the
#   stable-diffusion.cpp WanModel; under the registry build, Metal aborts
#   mid-generation with `unsupported op 'IM2COL_3D'` (hard ggml_abort()).
#
#   The fork commit `bc053644 metal: add IM2COL_3D op and PAD left-padding
#   support for Wan video` adds those two op implementations to the Metal
#   backend. This overlay swaps the registry port for the diffusion-cpp
#   addon's build only -- other monorepo packages keep using the
#   upstream-pinned ggml from the registry.
#
#   Source:  https://github.com/tetherto/qvac-ext-ggml
#   Branch:  feature/metal-pr-16669-clean
#   Pinned:  bc05364491048ff92e4c28778b5a5ed9e38e530f
#
# Installed artefacts (same as registry port):
#   include/ggml.h  (+ other ggml public headers)
#   lib/libggml.a, lib/libggml-base.a, lib/libggml-cpu.a, …
#   lib/cmake/ggml/  (CMake package config)
#
# GPU backend selection via vcpkg features:
#   metal  -> GGML_METAL=ON  (macOS/iOS, default-feature on Apple platforms)
#   vulkan -> GGML_VULKAN=ON
#   cuda   -> GGML_CUDA=ON
#   opencl -> GGML_OPENCL=ON

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF bc05364491048ff92e4c28778b5a5ed9e38e530f
    SHA512 c4c8375b88a6b358a9b5385cdc8cf2ad740c53498c1180cbae7640ce7ad97f2b1c48a15f013de087649619a2a0b112ad204adf40184b829a21d6c9c3c2cc6e24
    HEAD_REF feature/metal-pr-16669-clean
    PATCHES
        ggml-max-name.patch
        ggml-opencl-public-header.patch
        ggml-opencl-graceful-no-devices.patch
        ggml-config-include-dir.patch
        ggml-static-core-dl-backends.patch
        ggml-cpu-static-hybrid.patch
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
    # Locate nvcc explicitly — /usr/local/cuda/bin may not be on the PATH that
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

# Hybrid backend mode for Android: GPU backends (Vulkan, OpenCL) are MODULE
# .so files loaded at runtime via dlopen — no libOpenCL.so NEEDED dependency.
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
    file(GLOB _backend_sos "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/bin/libggml-*.so")
    if(_backend_sos)
        file(INSTALL ${_backend_sos} DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
    endif()
endif()

# Fix up the CMake package config installed by ggml's own build system.
vcpkg_cmake_config_fixup(PACKAGE_NAME ggml CONFIG_PATH lib/cmake/ggml)

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


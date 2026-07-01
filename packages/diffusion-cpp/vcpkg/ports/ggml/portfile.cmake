# ggml vcpkg overlay port for qvac-ext-ggml 2026-06-06-on-fabric-ggml.
#
# This fabric-based branch preserves qvac-fabric-llm.cpp's Adreno OpenCL Q4_0
# preallocated transpose-buffer path, then replays the QVAC stable-diffusion.cpp
# kernels from the 2026-06-06 line (Metal IM2COL_3D/PAD/fused RoPE, hybrid
# backend packaging, Vulkan coopmat1 f32-accum/GQA flash-attn, and serialized
# OpenCL SOA tensor uploads).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF 01a74afa875902d46ec2b4a03a955f1201060d97
    SHA512 fa8c72343817a8d73759061197ab238b45f338a8e7a9bdae65309776287080853964b944e47fb89e578a40262a86966e84c31c04fa290420315db6d2f7fe2c45
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
    file(COPY "${SOURCE_PATH}/Vulkan-Headers-${vulkan_version}/include/"
         DESTINATION "${SOURCE_PATH}/src/")
endif()

# --- Platform options ---
set(PLATFORM_OPTIONS)

if(VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
endif()

if(VCPKG_TARGET_IS_ANDROID)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BACKEND_DL=ON
        -DGGML_CPU_STATIC=ON
        -DGGML_VULKAN_DISABLE_COOPMAT=ON
        -DGGML_VULKAN_DISABLE_COOPMAT2=ON
    )
endif()

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
        -DGGML_MAX_NAME=128
        ${GGML_CUDA_COMPILER_OPTION}
        ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

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

vcpkg_cmake_config_fixup(PACKAGE_NAME ggml CONFIG_PATH share/ggml)

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

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

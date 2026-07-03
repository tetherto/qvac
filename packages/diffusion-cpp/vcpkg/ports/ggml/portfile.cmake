# ggml vcpkg overlay port
#
# Builds the ggml tensor library from tetherto/qvac-ext-ggml.
# Fork of ggml-org/ggml with all overlay patches pre-applied, plus the
# downstream LTX support currently under review.
#
# Pulls from tetherto/qvac-ext-ggml branch 2026-06-06-on-fabric-ggml (REF
# pinned to its tip 01a74afa for reproducibility). This rebases the 2026-06-06
# compute stack on the fabric ggml subtree, including the Adreno OpenCL Q4_0
# allocation fix plus the OpenCL SOA tensor-upload serialization fix found on
# the S25. It also carries the merged Metal fused Flux RoPE kernel,
# implicit-GEMM conv2d + flash-attention fix, Wan IM2COL_3D/PAD, the coopmat1
# flash-attn f32-accumulation fixes, and the ggml_graph_leaf/leafs/n_leafs
# public API export.
vcpkg_from_git(
    OUT_SOURCE_PATH SOURCE_PATH
    URL "https://github.com/tetherto/qvac-ext-ggml.git"
    REF 01a74afa875902d46ec2b4a03a955f1201060d97
)

# Only build Release; ggml's Android install exports release CMake package
# files, and the addon prebuild does not need a debug dependency build.
set(VCPKG_BUILD_TYPE release)

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
    # Locate nvcc explicitly; /usr/local/cuda/bin may not be on the PATH that
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

# The fabric ggml Vulkan backend includes vma/VmaUsage.h through a
# ../../../vendor include path from src/ggml-vulkan. Recreate that small vendor
# layout for this standalone ggml source checkout.
if("vulkan" IN_LIST FEATURES)
    set(VMA_VENDOR_REF e9ad5fc9f6d5120639ed98d0c9248a83b7eaa04c)
    set(VMA_VENDOR_DIR "${SOURCE_PATH}/../vendor/vma")
    file(MAKE_DIRECTORY "${VMA_VENDOR_DIR}")
    file(DOWNLOAD
        "https://raw.githubusercontent.com/tetherto/qvac-fabric-llm.cpp/${VMA_VENDOR_REF}/vendor/vma/VmaUsage.h"
        "${VMA_VENDOR_DIR}/VmaUsage.h"
        TLS_VERIFY ON
    )
    file(DOWNLOAD
        "https://raw.githubusercontent.com/tetherto/qvac-fabric-llm.cpp/${VMA_VENDOR_REF}/vendor/vma/vk_mem_alloc.h"
        "${VMA_VENDOR_DIR}/vk_mem_alloc.h"
        TLS_VERIFY ON
    )
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
    # which resolves to src/ for backends under src/ggml-vulkan/. Placing the
    # headers at src/vulkan/*.hpp makes #include <vulkan/vulkan.hpp> resolve.
    file(COPY "${SOURCE_PATH}/Vulkan-Headers-${vulkan_version}/include/"
         DESTINATION "${SOURCE_PATH}/src/")
endif()

# QVAC diffusion-cpp publishes one static addon per desktop platform, so every
# generated Vulkan shader byte is duplicated across npm prebuilds. The supported
# model set does not include TBQ/PQ quantized checkpoints; keep the generated
# symbol names so ggml's pipeline registration still compiles, but replace those
# shader bodies with tiny no-op compute shaders.
set(_QVAC_VULKAN_SHADER_GEN "${SOURCE_PATH}/src/ggml-vulkan/vulkan-shaders/vulkan-shaders-gen.cpp")
file(READ "${_QVAC_VULKAN_SHADER_GEN}" _qvac_vulkan_shader_gen)
string(REPLACE
    "void string_to_spv_func(std::string name, std::string in_path, std::string out_path, std::map<std::string, std::string> defines, bool coopmat, bool dep_file, compile_count_guard slot) {\n    std::string target_env"
    "void string_to_spv_func(std::string name, std::string in_path, std::string out_path, std::map<std::string, std::string> defines, bool coopmat, bool dep_file, compile_count_guard slot) {\n    if (name.find(\"tbq\") != std::string::npos || name.find(\"pq\") != std::string::npos) {\n        const std::string noop_path = out_path + \".noop.comp\";\n        write_binary_file(noop_path, \"#version 450\\nlayout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;\\nvoid main() {}\\n\");\n        in_path = noop_path;\n        defines.clear();\n        coopmat = false;\n    }\n\n    std::string target_env"
    _qvac_vulkan_shader_gen "${_qvac_vulkan_shader_gen}")
file(WRITE "${_QVAC_VULKAN_SHADER_GEN}" "${_qvac_vulkan_shader_gen}")
unset(_qvac_vulkan_shader_gen)

# --- Platform options ---
set(PLATFORM_OPTIONS)
set(GGML_VULKAN_BUILD_ADRENO_SHADERS OFF)

if(VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
endif()

# Hybrid backend mode for Android: GPU backends (Vulkan, OpenCL) are MODULE
# .so files loaded at runtime via dlopen; the CPU backend is statically linked.
if(VCPKG_TARGET_IS_ANDROID)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BACKEND_DL=ON
        -DGGML_CPU_STATIC=ON
        -DGGML_VULKAN_DISABLE_COOPMAT=ON
        -DGGML_VULKAN_DISABLE_COOPMAT2=ON
    )
    set(GGML_VULKAN_BUILD_ADRENO_SHADERS ON)
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
        -DGGML_OPENCL_KERNEL_CACHE=OFF
        -DGGML_VULKAN_BUILD_ADRENO_SHADERS=${GGML_VULKAN_BUILD_ADRENO_SHADERS}
        -DGGML_MAX_NAME=128
        ${GGML_CUDA_COMPILER_OPTION}
        ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

# Install DL backend .so files for Android. ggml builds each backend as a
# MODULE target but does not install them via cmake install().
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

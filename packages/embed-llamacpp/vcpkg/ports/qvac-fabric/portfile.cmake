vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO zoq/qvac-ext-lib-llama.cpp
  REF bc85668ffad0394d4973d9e08eb8373871188d02
  SHA512 0ae829a9d62af533d3803a5a67388fe2d3b6dc39a9b0c80a64f893253a37378365c7b3712ad6f6e1216ee63625f12d0e5b26e2cfaea0f2da1a35e65cb3e17b27
)

vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    force-profiler FORCE_GGML_VK_PERF_LOGGER
    llama BUILD_LLAMA
)

set(_qvac_gpu_backends OFF)
if("gpu-backends" IN_LIST FEATURES)
  set(_qvac_gpu_backends ON)
else()
  message(STATUS "qvac-fabric: gpu-backends feature OFF — building CPU-only ggml (no Metal/Vulkan/CUDA/OpenCL)")
endif()

if (VCPKG_TARGET_IS_ANDROID AND _qvac_gpu_backends)
  # NDK only comes with C headers. Pull Vulkan and SPIR-V headers from
  # Khronos and drop them under ggml/src/ggml-vulkan/vulkan_cpp_wrapper/include,
  # which ggml-vulkan/CMakeLists.txt adds to the include path. Idempotent —
  # safe to re-run against an existing local SOURCE_PATH checkout.
  include(${CMAKE_CURRENT_LIST_DIR}/android-vulkan-version.cmake)
  detect_ndk_vulkan_version()
  message(STATUS "Using Vulkan C++ wrappers from version: ${vulkan_version}")

  set(_vk_wrapper "${SOURCE_PATH}/ggml/src/ggml-vulkan/vulkan_cpp_wrapper")
  if(NOT EXISTS "${_vk_wrapper}/include/vulkan/vulkan.hpp")
    file(REMOVE_RECURSE "${_vk_wrapper}" "${SOURCE_PATH}/Vulkan-Headers-${vulkan_version}")
    file(DOWNLOAD
      "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v${vulkan_version}.tar.gz"
      "${SOURCE_PATH}/vulkan-sdk-${vulkan_version}.tar.gz"
      TLS_VERIFY ON
    )
    file(ARCHIVE_EXTRACT
      INPUT "${SOURCE_PATH}/vulkan-sdk-${vulkan_version}.tar.gz"
      DESTINATION "${SOURCE_PATH}"
      PATTERNS "*.hpp"
    )
    file(RENAME
      "${SOURCE_PATH}/Vulkan-Headers-${vulkan_version}"
      "${_vk_wrapper}"
    )
    file(REMOVE "${SOURCE_PATH}/vulkan-sdk-${vulkan_version}.tar.gz")
  endif()

  set(_spv_version "1.3.290.0")
  if(NOT EXISTS "${_vk_wrapper}/include/spirv/unified1/spirv.hpp")
    file(REMOVE_RECURSE "${SOURCE_PATH}/SPIRV-Headers-vulkan-sdk-${_spv_version}")
    file(DOWNLOAD
      "https://github.com/KhronosGroup/SPIRV-Headers/archive/refs/tags/vulkan-sdk-${_spv_version}.tar.gz"
      "${SOURCE_PATH}/spirv-headers-${_spv_version}.tar.gz"
      TLS_VERIFY ON
    )
    file(ARCHIVE_EXTRACT
      INPUT "${SOURCE_PATH}/spirv-headers-${_spv_version}.tar.gz"
      DESTINATION "${SOURCE_PATH}"
    )
    file(COPY "${SOURCE_PATH}/SPIRV-Headers-vulkan-sdk-${_spv_version}/include/spirv"
         DESTINATION "${_vk_wrapper}/include")
    file(REMOVE_RECURSE "${SOURCE_PATH}/SPIRV-Headers-vulkan-sdk-${_spv_version}")
    file(REMOVE "${SOURCE_PATH}/spirv-headers-${_spv_version}.tar.gz")
  endif()
endif()

set(PLATFORM_OPTIONS)

if(NOT _qvac_gpu_backends)
  # Force every GPU backend off explicitly, in case upstream defaults change.
  list(APPEND PLATFORM_OPTIONS
    -DGGML_METAL=OFF
    -DGGML_VULKAN=OFF
    -DGGML_CUDA=OFF
    -DGGML_OPENCL=OFF
  )
  if (VCPKG_TARGET_IS_IOS)
    # Same iOS BLAS/Accelerate gating as the GPU-on path; unrelated to the
    # CPU-vs-GPU split, an iOS-toolchain workaround for missing frameworks.
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
  endif()
elseif (VCPKG_TARGET_IS_OSX OR VCPKG_TARGET_IS_IOS)
  list(APPEND PLATFORM_OPTIONS -DGGML_METAL=ON)
  if (VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
  endif()
else()
  list(APPEND PLATFORM_OPTIONS -DGGML_VULKAN=ON)
endif()

if(VCPKG_TARGET_IS_ANDROID AND _qvac_gpu_backends)
  set(DL_BACKENDS ON)
  list(APPEND PLATFORM_OPTIONS
    -DGGML_BACKEND_DL=ON
    -DGGML_CPU_ALL_VARIANTS=ON
    -DGGML_CPU_REPACK=ON
    -DGGML_OPENCL=ON
  )
else()
  set(DL_BACKENDS OFF)
endif()

set(LLAMA_OPTIONS)
if("llama" IN_LIST FEATURES)
  list(APPEND LLAMA_OPTIONS -DLLAMA_MTMD=ON)
else()
  list(APPEND LLAMA_OPTIONS
    -DLLAMA_MTMD=OFF
    -DLLAMA_BUILD_COMMON=OFF
  )
endif()

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DGGML_NATIVE=OFF
    -DGGML_CCACHE=OFF
    -DGGML_OPENMP=OFF
    -DGGML_LLAMAFILE=OFF
    -DLLAMA_CURL=OFF
    -DLLAMA_BUILD_TESTS=OFF
    -DLLAMA_BUILD_TOOLS=OFF
    -DLLAMA_BUILD_EXAMPLES=OFF
    -DLLAMA_BUILD_SERVER=OFF
    -DLLAMA_ALL_WARNINGS=OFF
    ${LLAMA_OPTIONS}
    ${PLATFORM_OPTIONS}
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()
vcpkg_cmake_config_fixup(
  PACKAGE_NAME ggml)

if(BUILD_LLAMA)
  vcpkg_cmake_config_fixup(PACKAGE_NAME llama)
endif()

vcpkg_copy_pdbs()
vcpkg_fixup_pkgconfig()


if(BUILD_LLAMA)
  file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  file(RENAME "${CURRENT_PACKAGES_DIR}/bin/convert_hf_to_gguf.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/convert-hf-to-gguf.py")
  file(INSTALL "${SOURCE_PATH}/gguf-py" DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  file(RENAME "${CURRENT_PACKAGES_DIR}/bin/vulkan_profiling_analyzer.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/vulkan_profiling_analyzer.py")
endif()

if (NOT VCPKG_BUILD_TYPE)
  file(REMOVE "${CURRENT_PACKAGES_DIR}/debug/bin/convert_hf_to_gguf.py")
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (NOT DL_BACKENDS AND VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

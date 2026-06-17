# DEV OVERLAY — points to yingying0906/qvac-fabric-llm.cpp feat/qwen3vl-multi-tile-batching
# Remove this directory to restore the registry version.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO yingying0906/qvac-fabric-llm.cpp
  REF 2b1c17f8bc79ddbaa9b80417337e0cc5ec5e30bf
  SHA512 5f80deb3552fa556aa40d6121fbae5a76544fe2e02e5ba024e26563ed2cb3a65c25b37b8a88775f85a3d47f96173b88427c2723e59e20f250979738b4f337c97
)

vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    force-profiler FORCE_GGML_VK_PERF_LOGGER
    llama BUILD_LLAMA
)

vcpkg_check_features(
  OUT_FEATURE_OPTIONS _PORTFILE_FEATURE_OPTIONS
  FEATURES
    gpu-backends BUILD_GPU_BACKENDS
    kleidiai BUILD_KLEIDIAI
    openmp BUILD_OPENMP
)

if(NOT BUILD_GPU_BACKENDS)
  message(STATUS "qvac-fabric: gpu-backends feature OFF — building CPU-only ggml (no Metal/Vulkan/CUDA/OpenCL)")
endif()

if (VCPKG_TARGET_IS_ANDROID AND BUILD_GPU_BACKENDS)
  include(${CMAKE_CURRENT_LIST_DIR}/android-vulkan-version.cmake)
  detect_ndk_vulkan_version()
  message(STATUS "Using Vulkan C++ wrappers from version: ${vulkan_version}")
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
    "${SOURCE_PATH}/ggml/src/ggml-vulkan/vulkan_cpp_wrapper"
  )
endif()

set(PLATFORM_OPTIONS)

if(NOT BUILD_GPU_BACKENDS)
  list(APPEND PLATFORM_OPTIONS
    -DGGML_METAL=OFF
    -DGGML_VULKAN=OFF
    -DGGML_CUDA=OFF
    -DGGML_OPENCL=OFF
  )
  if (VCPKG_TARGET_IS_IOS)
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

if(VCPKG_TARGET_IS_ANDROID)
  set(DL_BACKENDS ON)
  list(APPEND PLATFORM_OPTIONS
    -DGGML_BACKEND_DL=ON
    -DGGML_CPU_ALL_VARIANTS=ON
    -DGGML_CPU_REPACK=ON)
else()
  set(DL_BACKENDS OFF)
endif()

if(VCPKG_TARGET_IS_ANDROID AND BUILD_KLEIDIAI)
  message(STATUS "qvac-fabric: kleidiai feature ON — building with ARM KleidiAI optimized kernels")
  list(APPEND PLATFORM_OPTIONS
    -DGGML_CPU_KLEIDIAI=ON
    -DFETCHCONTENT_FULLY_DISCONNECTED=OFF
  )
endif()

if(VCPKG_TARGET_IS_ANDROID AND BUILD_OPENMP)
  message(STATUS "qvac-fabric: OpenMP for Android enabled")
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENMP=ON)
else()
  message(STATUS "qvac-fabric: OpenMP Disabled")
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENMP=OFF)
endif()

if (VCPKG_TARGET_IS_ANDROID AND BUILD_GPU_BACKENDS)
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENCL=ON)
endif()

if(BUILD_GPU_BACKENDS AND NOT VCPKG_TARGET_IS_OSX AND NOT VCPKG_TARGET_IS_IOS)
  if(VCPKG_TARGET_IS_WINDOWS AND NOT VCPKG_TARGET_IS_MINGW)
    string(APPEND VCPKG_C_FLAGS " /I${CURRENT_INSTALLED_DIR}/include")
    string(APPEND VCPKG_CXX_FLAGS " /I${CURRENT_INSTALLED_DIR}/include")
  else()
    string(APPEND VCPKG_C_FLAGS " -isystem ${CURRENT_INSTALLED_DIR}/include")
    string(APPEND VCPKG_CXX_FLAGS " -isystem ${CURRENT_INSTALLED_DIR}/include")
  endif()
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
vcpkg_cmake_config_fixup(PACKAGE_NAME ggml)

if(BUILD_LLAMA)
  vcpkg_cmake_config_fixup(PACKAGE_NAME llama)
endif()

vcpkg_copy_pdbs()
vcpkg_fixup_pkgconfig()

if(BUILD_LLAMA)
  file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  file(RENAME "${CURRENT_PACKAGES_DIR}/bin/convert_hf_to_gguf.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/convert-hf-to-gguf.py")
  file(INSTALL "${SOURCE_PATH}/gguf-py" DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  if(EXISTS "${CURRENT_PACKAGES_DIR}/bin/vulkan_profiling_analyzer.py")
    file(RENAME "${CURRENT_PACKAGES_DIR}/bin/vulkan_profiling_analyzer.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/vulkan_profiling_analyzer.py")
  endif()
endif()

if (NOT VCPKG_BUILD_TYPE)
  file(REMOVE "${CURRENT_PACKAGES_DIR}/debug/bin/convert_hf_to_gguf.py")
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

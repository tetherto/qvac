vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-ext-lib-llama.cpp
  REF v${VERSION}
  SHA512 75fd21f4f510f0de1b0b171b2fcb4249dc983e3f05f7e401518733ffa9f2f144b8e035d4581d6d2c993ec1a0b4d4a4aa404365f5f38290236515125b34fe956c
)

vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    force-profiler FORCE_GGML_VK_PERF_LOGGER
)

if (VCPKG_TARGET_IS_ANDROID)
  # NDK only comes with C headers.
  # Make sure C++ header exists, it will be used by ggml tensor library.
  # Need to determine installed vulkan version and download correct headers
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

if (VCPKG_TARGET_IS_OSX OR VCPKG_TARGET_IS_IOS)
  list(APPEND PLATFORM_OPTIONS -DGGML_METAL=ON)
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

if (VCPKG_TARGET_IS_ANDROID)
  list(APPEND PLATFORM_OPTIONS
    -DGGML_VULKAN_DISABLE_COOPMAT=ON
    -DGGML_VULKAN_DISABLE_COOPMAT2=ON
    -DGGML_OPENCL=ON)
endif()

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DGGML_NATIVE=OFF
    -DGGML_CCACHE=OFF
    -DGGML_OPENMP=OFF
    -DGGML_LLAMAFILE=OFF
    -DLLAMA_MTMD=ON
    -DLLAMA_CURL=OFF
    -DLLAMA_BUILD_TESTS=OFF
    -DLLAMA_BUILD_TOOLS=OFF
    -DLLAMA_BUILD_EXAMPLES=OFF
    -DLLAMA_BUILD_SERVER=OFF
    -DLLAMA_ALL_WARNINGS=OFF
    ${PLATFORM_OPTIONS}
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()
vcpkg_cmake_config_fixup(
  PACKAGE_NAME llama)
vcpkg_cmake_config_fixup(
  PACKAGE_NAME ggml)

vcpkg_copy_pdbs()
vcpkg_fixup_pkgconfig()

file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
file(RENAME "${CURRENT_PACKAGES_DIR}/bin/convert_hf_to_gguf.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/convert-hf-to-gguf.py")
file(INSTALL "${SOURCE_PATH}/gguf-py" DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
file(RENAME "${CURRENT_PACKAGES_DIR}/bin/vulkan_profiling_analyzer.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/vulkan_profiling_analyzer.py")

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

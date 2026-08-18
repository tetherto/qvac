# LOCAL OVERLAY for qvac-fabric (turbovec).
#
# Pinned by default to a commit on
#   https://github.com/dev-nid/qvac-fabric-llm.cpp.git
# (branch: turbovec-cpu-pr1-core)
# which combines the fabric TurboVec/vector-index sub-PRs on top of
# the fabric line consumed by embed-llamacpp.
#
# Why an overlay at all: the public `tetherto/qvac-registry-vcpkg` port
# does not yet carry the turbovec/vector-index fabric changes. This
# overlay is the temporary source of truth until that port is published
# in the registry.
#
# Local-edit iteration (Phase 0 fast loop) — set QVAC_FABRIC_LOCAL_PATH
# to the path of a fabric working tree. The overlay then copies that
# directory into the vcpkg buildtree instead of fetching from github.
# Because vcpkg's ABI hash is derived from the portfile contents (not
# the source it copies in), use `./scripts/sync-fabric-overlay.sh` to
# bump the `# fabric-src-hash:` comment line on each iteration so vcpkg
# rebuilds the port.

# fabric-src-hash: 12ff806fd708b71d907a7030478d0fea7c68f1d8

set(FABRIC_GH_REPO "dev-nid/qvac-fabric-llm.cpp")
set(FABRIC_GH_REF  "12ff806fd708b71d907a7030478d0fea7c68f1d8")  # turbovec-cpu-pr1-core
set(FABRIC_GH_HEAD_REF "turbovec-cpu-pr1-core")
set(FABRIC_GH_SHA512
    "75b15272e9c42005fa14c74a41a36fccff320fd05797b479722389b21c50a63dcd3f53faf9db35aede0d7848f2cf0d4e972418deecbce6246473c82aa0adebb1")

if(DEFINED ENV{QVAC_FABRIC_LOCAL_PATH})
  set(FABRIC_LOCAL_PATH "$ENV{QVAC_FABRIC_LOCAL_PATH}")
  if(NOT EXISTS "${FABRIC_LOCAL_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
      "qvac-fabric overlay: QVAC_FABRIC_LOCAL_PATH='${FABRIC_LOCAL_PATH}' "
      "is not a fabric checkout (no CMakeLists.txt).")
  endif()
  message(STATUS
    "qvac-fabric overlay: LOCAL mode — copying source from ${FABRIC_LOCAL_PATH}")
  set(SOURCE_PATH "${CURRENT_BUILDTREES_DIR}/src/qvac-fabric-local")
  file(REMOVE_RECURSE "${SOURCE_PATH}")
  file(MAKE_DIRECTORY "${SOURCE_PATH}")
  file(COPY "${FABRIC_LOCAL_PATH}/"
       DESTINATION "${SOURCE_PATH}"
       PATTERN ".git" EXCLUDE
       PATTERN "build*" EXCLUDE
       PATTERN ".cache" EXCLUDE
       PATTERN "node_modules" EXCLUDE
       PATTERN "__pycache__" EXCLUDE
       PATTERN ".venv" EXCLUDE)
else()
  message(STATUS
    "qvac-fabric overlay: GITHUB mode — fetching ${FABRIC_GH_REPO}@${FABRIC_GH_REF}")
  vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO ${FABRIC_GH_REPO}
    REF ${FABRIC_GH_REF}
    SHA512 ${FABRIC_GH_SHA512}
    HEAD_REF ${FABRIC_GH_HEAD_REF})
endif()

vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    force-profiler FORCE_GGML_VK_PERF_LOGGER
    llama BUILD_LLAMA
)

if (VCPKG_TARGET_IS_ANDROID)
  include(${CMAKE_CURRENT_LIST_DIR}/android-vulkan-version.cmake)
  resolve_vulkan_headers_version(vulkan_version)
  resolve_vulkan_headers_sha512("${vulkan_version}" vulkan_headers_sha512)
  message(STATUS "Using Vulkan C++ wrappers from version: ${vulkan_version}")
  vcpkg_download_distfile(VULKAN_HEADERS_ARCHIVE
    URLS "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v${vulkan_version}.tar.gz"
    FILENAME "KhronosGroup-Vulkan-Headers-v${vulkan_version}.tar.gz"
    SHA512 "${vulkan_headers_sha512}"
  )
  file(ARCHIVE_EXTRACT
    INPUT "${VULKAN_HEADERS_ARCHIVE}"
    DESTINATION "${SOURCE_PATH}"
    PATTERNS "*.hpp"
  )
  file(RENAME
    "${SOURCE_PATH}/Vulkan-Headers-${vulkan_version}"
    "${SOURCE_PATH}/ggml/src/ggml-vulkan/vulkan_cpp_wrapper"
  )

  # The pinned fabric source fetches Vulkan-Headers for Android, but that
  # archive no longer contains the Vulkan-Hpp C++ bindings. Add the wrappers
  # downloaded above to ggml-vulkan's private include paths.
  set(vulkan_cmake_file
      "${SOURCE_PATH}/ggml/src/ggml-vulkan/CMakeLists.txt")
  file(READ "${vulkan_cmake_file}" vulkan_cmake_contents)
  if(NOT vulkan_cmake_contents MATCHES "vulkan_cpp_wrapper/include")
    vcpkg_replace_string(
      "${vulkan_cmake_file}"
      [=[        target_include_directories(ggml-vulkan PRIVATE
            "${vulkan_headers_SOURCE_DIR}/include"
            "${spirv_headers_SOURCE_DIR}/include")]=]
      [=[        target_include_directories(ggml-vulkan PRIVATE
            "${CMAKE_CURRENT_SOURCE_DIR}/vulkan_cpp_wrapper/include"
            "${vulkan_headers_SOURCE_DIR}/include"
            "${spirv_headers_SOURCE_DIR}/include")]=]
    )
  endif()
endif()

set(PLATFORM_OPTIONS)

if (VCPKG_TARGET_IS_OSX OR VCPKG_TARGET_IS_IOS)
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
    -DGGML_VECTOR_INDEX=ON
    -DGGML_CCACHE=OFF
    -DGGML_OPENMP=OFF
    -DGGML_LLAMAFILE=OFF
    -DLLAMA_MTMD=ON
    -DLLAMA_CURL=OFF
    -DLLAMA_BUILD_TESTS=OFF
    -DLLAMA_BUILD_TOOLS=OFF
    -DLLAMA_BUILD_EXAMPLES=OFF
    -DLLAMA_BUILD_SERVER=OFF
    -DLLAMA_BUILD_APP=OFF
    -DLLAMA_ALL_WARNINGS=OFF
    ${PLATFORM_OPTIONS}
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()
# Different fabric branches install CMake configs at either
# `lib/cmake/<pkg>` (HEAD-ish) or the upstream-standard `share/<pkg>`
# (temp-8828 / v7248.x). Detect which is present per package so the
# overlay works against both layouts without portfile edits.
if(EXISTS "${CURRENT_PACKAGES_DIR}/lib/cmake/ggml")
  vcpkg_cmake_config_fixup(
    PACKAGE_NAME ggml
    CONFIG_PATH "lib/cmake/ggml"
    DO_NOT_DELETE_PARENT_CONFIG_PATH)
else()
  vcpkg_cmake_config_fixup(PACKAGE_NAME ggml)
endif()

if(BUILD_LLAMA)
  if(EXISTS "${CURRENT_PACKAGES_DIR}/lib/cmake/llama")
    vcpkg_cmake_config_fixup(PACKAGE_NAME llama CONFIG_PATH "lib/cmake/llama")
  else()
    vcpkg_cmake_config_fixup(PACKAGE_NAME llama)
  endif()
endif()

vcpkg_copy_pdbs()
vcpkg_fixup_pkgconfig()

if(BUILD_LLAMA)
  file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  if(EXISTS "${CURRENT_PACKAGES_DIR}/bin/convert_hf_to_gguf.py")
    file(RENAME
      "${CURRENT_PACKAGES_DIR}/bin/convert_hf_to_gguf.py"
      "${CURRENT_PACKAGES_DIR}/tools/${PORT}/convert-hf-to-gguf.py")
  endif()
  if(EXISTS "${SOURCE_PATH}/gguf-py")
    file(INSTALL "${SOURCE_PATH}/gguf-py"
         DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  endif()
  # Vulkan-only artifact; absent on macOS (Metal backend) and iOS.
  if(EXISTS "${CURRENT_PACKAGES_DIR}/bin/vulkan_profiling_analyzer.py")
    file(RENAME
      "${CURRENT_PACKAGES_DIR}/bin/vulkan_profiling_analyzer.py"
      "${CURRENT_PACKAGES_DIR}/tools/${PORT}/vulkan_profiling_analyzer.py")
  endif()
endif()

if (NOT VCPKG_BUILD_TYPE)
  if(EXISTS "${CURRENT_PACKAGES_DIR}/debug/bin/convert_hf_to_gguf.py")
    file(REMOVE "${CURRENT_PACKAGES_DIR}/debug/bin/convert_hf_to_gguf.py")
  endif()
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

# Local fabric HEAD's llama-config.cmake `set_and_check`s LLAMA_BIN_DIR
# even for static builds, so we keep an (empty) bin/ around. Upstream's
# tagged release didn't, hence the original removal block. Preserve the
# dirs so `find_package(llama)` succeeds.
set(VCPKG_POLICY_ALLOW_EMPTY_FOLDERS enabled)
file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/bin")
file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/debug/bin")

# Fabric branches differ in where (and whether) they install the `common/`
# headers from the llama helper library. The embed-llamacpp addon code
# references them as both `<common/...>` and `<llama/common/...>`. To make
# both forms resolve to the same physical file (otherwise duplicate
# struct definitions break the build), normalize the layout:
#   - Prefer `include/llama/common/`. The addon's `-isystem
#     include/llama` lets `<common/...>` fall through to that path.
#   - Remove a redundant `include/common/` if both exist (the two trees
#     would otherwise be distinct files for the preprocessor and re-define
#     every struct on second inclusion).
#   - Synthesize `include/llama/common/` from source if neither is present.
if(BUILD_LLAMA AND EXISTS "${SOURCE_PATH}/common")
  set(_qvac_common_have_llama
      "${CURRENT_PACKAGES_DIR}/include/llama/common/common.h")
  set(_qvac_common_have_root
      "${CURRENT_PACKAGES_DIR}/include/common/common.h")
  if(EXISTS "${_qvac_common_have_llama}")
    if(EXISTS "${_qvac_common_have_root}")
      file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/include/common")
    endif()
  elseif(NOT EXISTS "${_qvac_common_have_root}")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/include/llama/common")
    file(COPY "${SOURCE_PATH}/common/"
         DESTINATION "${CURRENT_PACKAGES_DIR}/include/llama/common"
         FILES_MATCHING
           PATTERN "*.h"
           PATTERN "*.hpp"
           PATTERN "*.inc")
  endif()
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

# Package-local triplets first (they layer extra flags on top of the repo
# overlays, e.g. vcpkg/triplets/x64-linux.cmake appends -Wno-array-bounds),
# repo-wide overlays second.
set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

set(VCPKG_INSTALL_OPTIONS --clean-after-build)

project(asr-ggml CXX C)

qvac_addon_project_setup(VALGRIND_SUPP PRE_COMMIT_HOOK)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_path(
  QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/ModelInterfaces.hpp"
  REQUIRED
)

# Fuzz-only configure (BUILD_FUZZING without BUILD_TESTING): build just the
# fuzz targets and skip engine find_package() + the .bare module so pure
# parse/transform drivers keep full ASan + LSan.
qvac_addon_fuzz_only_return()

# The ggml runtime is the shared @qvac/fabric prebuild (dynamically linked,
# loaded once per process, its backends found and loaded by fabric itself);
# sets qvac_fabric_target.
qvac_addon_use_fabric()

find_package(whisper CONFIG REQUIRED)
find_package(qvac-parakeet CONFIG REQUIRED)

# whisper and parakeet were compiled against the same ggml headers; their ggml
# symbols come from the shared runtime, not from the qvac-fabric port's static
# archives.
qvac_addon_engine_on_fabric(whisper::whisper qvac::parakeet qvac::parakeet-backend-defs)

# Define _DEBUG for debug builds
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

# The module is named after the platform package that ships it,
# qvac__asr-ggml-<suffix> (every iOS host shares `ios`), so that package is an
# ordinary addon: require.addon(), bare-pack and bare-link all find
# prebuilds/<host>/qvac__asr-ggml-<suffix>.bare there. Keep the suffix in sync
# with "#host-addon" in package.json and SLICE_DEFINITIONS in
# scripts/ci/slice-platform-packages.mjs.
bare_target(bare_target_value)
if(bare_target_value MATCHES "^ios-")
  set(module_name "qvac__asr-ggml-ios")
else()
  set(module_name "qvac__asr-ggml-${bare_target_value}")
endif()

add_bare_module(asr-ggml NAME ${module_name} EXPORTS)

target_sources(
  ${asr-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/StreamingProcessor.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ParakeetStreamingProcessor.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper/WhisperConfig.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper/WhisperModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper/WhisperHandlers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/parakeet/ParakeetModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/parakeet/ParakeetConfig.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/moss/MossTranscribeModel.cpp
)

target_include_directories(
  ${asr-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${asr-ggml}
  PRIVATE
    whisper::whisper
    qvac::parakeet
)

qvac_addon_link_fabric(${asr-ggml} ${qvac_fabric_target})
qvac_addon_finalize(${asr-ggml})

if(WIN32)
  target_compile_options(${asr-ggml} PRIVATE "/utf-8")
endif()

bare_platform(PREBUILD_PLATFORM)
bare_arch(PREBUILD_ARCH)
set(PREBUILD_DIR "${CMAKE_SOURCE_DIR}/prebuilds/${PREBUILD_PLATFORM}-${PREBUILD_ARCH}")

if(ANDROID)
  if(CMAKE_STRIP)
    set(ANDROID_STRIP_TOOL "${CMAKE_STRIP}")
  else()
    set(ANDROID_STRIP_TOOL "$ENV{ANDROID_NDK}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip")
  endif()

  install(CODE "
    set(STRIP_TOOL \"${ANDROID_STRIP_TOOL}\")
    set(BINARY_PATH \"${PREBUILD_DIR}/${module_name}.bare\")
    if(EXISTS \"\${STRIP_TOOL}\")
      execute_process(COMMAND \"\${STRIP_TOOL}\" --strip-debug \"\${BINARY_PATH}\" RESULT_VARIABLE STRIP_RESULT)
      if(STRIP_RESULT EQUAL 0)
        message(STATUS \"Stripped debug symbols from Android binary\")
      else()
        message(WARNING \"Failed to strip Android binary\")
      endif()
    else()
      message(WARNING \"Strip tool not found at: \${STRIP_TOOL}\")
    endif()
  ")
endif()

if(BUILD_TESTING)
  enable_testing()
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  add_subdirectory(addon/tests)
endif()

qvac_addon_add_fuzz_subdirectory()

cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_COVERAGE "Enable coverage instrumentation for unit tests" OFF)
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

# Android STL configuration must be set before project()
if(DEFINED ENV{ANDROID_NDK} OR DEFINED ENV{ANDROID_NDK_HOME})
  set(ANDROID_STL c++_shared)
endif()

project(classification-ggml LANGUAGES C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(WIN32)
  add_definitions(-DWIN32_LEAN_AND_MEAN -DNOMINMAX -DNOGDI)
endif()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/JsInterface.hpp" REQUIRED)
find_path(STB_INCLUDE_DIRS "stb_image.h" REQUIRED)

# The ggml runtime is provided by @qvac/fabric (npm dependency) instead of being
# statically linked from the qvac-fabric vcpkg port. It ships the headers
# (qvac-fabric::headers) and a single shared .bare module that this addon
# dynamically links against, so the runtime is loaded once per process. All
# platforms (desktop and mobile) use this dynamic-linking model.
set(qvac-fabric_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/fabric/prebuilds/share/qvac-fabric/cmake")
find_package(qvac-fabric CONFIG REQUIRED)

include_bare_module("@qvac/fabric" qvac_fabric_target PREBUILD)

bare_target(bare_target_value)
# The ggml compute backends live under @qvac/fabric's own prebuilds subdir
# (prebuilds/<host>/qvac__fabric), not a per-addon copy. BACKENDS_SUBDIR is the
# "<host>/qvac__fabric" path the addon appends to the runtime-provided
# backendsDir (see index.js) when calling ggml_backend_load_all_from_path().
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/qvac__fabric")
message(STATUS "Building classification-ggml with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

add_bare_module(classification-ggml EXPORTS)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${classification-ggml}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

set(ADDON_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ClassificationModel.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ImagePreprocessor.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MobileNetGraph.cpp
)

target_sources(
  ${classification-ggml}
  PRIVATE
    ${ADDON_SOURCES}
)

target_include_directories(
  ${classification-ggml}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${STB_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

# Compile against the ggml headers...
target_link_libraries(
  ${classification-ggml}
  PRIVATE
    qvac-fabric::headers
)
# ...and dynamically link the shared runtime (DT_NEEDED qvac__fabric@0.bare).
target_link_libraries(
  ${classification-ggml}_module
  PRIVATE
    ${qvac_fabric_target}_module
)

target_compile_definitions(
  ${classification-ggml}
  PRIVATE
    JS_LOGGER
    BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}"
)

# On Linux and Android @qvac/fabric ships the ggml compute backends as separate
# GGML_BACKEND_DL modules (CPU micro-arch variants, Vulkan) that must be dlopen'd
# at runtime; tell the addon so load() loads them from backendsDir before
# querying the backend registry. On macOS/Windows/iOS the backends are static
# inside qvac__fabric@0.bare and self-register on load, so no dlopen is needed.
# Either way load() acquires the CPU device via the generic registry API
# (ggml_backend_dev_by_type); it never calls ggml_backend_cpu_init() directly,
# which @qvac/fabric does not export from its Windows DLL.
if((ANDROID OR UNIX) AND NOT APPLE)
  target_compile_definitions(${classification-ggml} PRIVATE GGML_BACKEND_DL)
endif()

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)
endif()

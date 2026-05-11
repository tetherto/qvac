cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_COVERAGE "Enable coverage instrumentation for unit tests" OFF)
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

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

find_package(ggml CONFIG REQUIRED)

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message(STATUS "Building classification-ggml with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    # GGML_AVAILABLE_BACKENDS advertises every backend the upstream port
    # knows about, but real CMake targets only exist for those actually
    # built into the installed package (e.g. ggml-vulkan / ggml-opencl
    # are absent on Android with our vcpkg feature set). Skip missing
    # ones so add_bare_module's get_target_property() doesn't error out.
    if(TARGET ggml::${_backend})
      list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
    endif()
  endforeach()
endif()

add_bare_module(classification-ggml EXPORTS ${BACKEND_DL_LIBS})

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

target_link_libraries(
  ${classification-ggml}
  PRIVATE
    ggml::ggml
    ggml::ggml-base
)

# CPU backend: with GGML_CPU_ALL_VARIANTS=ON (Android via qvac-fabric),
# the single ggml::ggml-cpu target doesn't exist — it's replaced by
# per-microarch variants (ggml::ggml-cpu-android_armv8.0_1, ...armv8.2_1,
# ...armv8.2_2, ...armv8.6_1) loaded as MODULE .so files at runtime via
# dlopen. On Apple/Linux/Windows desktop where variants are off,
# ggml::ggml-cpu exists as a single static target.
if(TARGET ggml::ggml-cpu)
  target_link_libraries(${classification-ggml} PRIVATE ggml::ggml-cpu)
endif()

target_compile_definitions(
  ${classification-ggml}
  PRIVATE
    JS_LOGGER
    BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}"
)

if(WIN32)
  target_link_libraries(
    ${classification-ggml}
    PRIVATE
      msvcrt.lib
  )
endif()

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)
endif()

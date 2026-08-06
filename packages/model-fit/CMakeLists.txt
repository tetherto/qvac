cmake_minimum_required(VERSION 3.25)

option(ANDROID_STL "Android STL linkage" c++_shared)
option(BUILD_TESTING "Build tests" OFF)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(model-fit C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

# Generated lint configs, mirroring the other native addons so `lint-cpp`
# has a .clang-format / .clang-tidy to work with.
find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)

# Header-only JS<->C++ marshalling helpers (JsArgsParser / jsu / JSCATCH).
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp")

# llama-targets.cmake transitively requires OpenSSL::SSL via cpp-httplib's
# IMPORTED interface, so make OpenSSL discoverable before find_package(llama).
find_package(OpenSSL)
find_package(llama CONFIG REQUIRED)

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_MEAN_AND_LEAN -DNOGDI)
endif()

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message("Building model-fit with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

# Install the ggml backend shared libs next to the prebuild. `common_fit_params`
# needs the backends loaded to query per-device free memory.
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
  endforeach()
endif()

add_bare_module(model-fit EXPORTS ${BACKEND_DL_LIBS})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${model-fit}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

set(ADDON_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/fit/FitParams.cpp
)

target_sources(${model-fit} PRIVATE ${ADDON_SOURCES})

target_include_directories(
  ${model-fit}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

target_link_libraries(
  ${model-fit}
  PRIVATE
    llama::llama
    # The fitter lives in libcommon, not the core llama ABI: upstream moved it
    # there in ggml-org/llama.cpp#22171, renaming llama_params_fit to
    # common_fit_params. llama.h no longer declares it, so linking llama alone
    # resolves nothing.
    llama::llama-common
)

target_compile_definitions(${model-fit} PUBLIC JS_LOGGER)
target_compile_definitions(${model-fit} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

# NOTE: do not link msvcrt.lib here. It is the *dynamic* CRT import library, and
# the monorepo ships Windows addons against the static runtime (QVAC-21100) so a
# prebuild carries no vcruntime140/ucrtbase dependency. The CRT comes from the
# vcpkg triplet (vcpkg-overlays/triplets/x64-windows.cmake, VCPKG_CRT_LINKAGE
# static) and the bare-make toolchain; naming it explicitly here overrode both.
# reusable-prebuilds.yml fails the win32 prebuild if those imports reappear.

cmake_minimum_required(VERSION 3.25)

option(ANDROID_STL "Android STL linkage" c++_shared)
option(BUILD_TESTING "Build tests" OFF)
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

option(SD_CUDA "Enable CUDA GPU backend" OFF)
if(SD_CUDA)
  list(APPEND VCPKG_MANIFEST_FEATURES "cuda")
endif()

option(SD_OPENCL "Enable OpenCL GPU backend (Android/Adreno)" OFF)
if(SD_OPENCL)
  list(APPEND VCPKG_MANIFEST_FEATURES "opencl")
endif()

# Vulkan and Metal are auto-enabled via default-features in the ggml and
# stable-diffusion-cpp overlay ports.  CUDA requires a specific build machine
# so it remains opt-in via SD_CUDA.
#
# GGML_BACKEND_DL is ON only on Android (set in the ggml portfile), mirroring
# qvac-fabric. On Linux/macOS/Windows GPU backends are statically linked.

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(qvac-lib-inference-addon-sd C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)

find_path(PICOJSON_INCLUDE_DIRS "picojson/picojson.h")
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/JsInterface.hpp")

# stable-diffusion.cpp – uses the CMake config installed by the overlay port
find_package(stable-diffusion-cpp CONFIG REQUIRED)

# ggml is installed alongside stable-diffusion.cpp as separate static libs.
# stable-diffusion.a references ggml symbols externally, so we must link them.
find_package(ggml CONFIG REQUIRED)

find_path(STB_IMAGE_WRITE_INCLUDE_DIR "stb_image_write.h" REQUIRED)

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI)
endif()

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message("Building qvac-lib-inference-addon-sd with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

# On Android with GGML_BACKEND_DL, install GPU backend .so modules alongside
# the addon so ggml can dlopen them at runtime.  CPU backends are statically
# linked (GGML_CPU_STATIC) and excluded from this loop.
set(BACKEND_DL_EXPORTS "")
if(ANDROID AND GGML_BACKEND_DL)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    if("${_backend}" MATCHES "^ggml-cpu")
      continue()
    endif()
    # qvac ggml overlays prefix backend module filenames (e.g.
    # libqvac-ggml-vulkan.so / libqvac-diffusion-ggml-vulkan.so). These
    # modules are installed under vcpkg's bin/ directory on Android.
    find_library(_${_backend}_LIB NAMES
      "qvac-diffusion-${_backend}"
      "${_backend}"
      PATHS
        "${VCPKG_INSTALLED_PATH}/bin"
        "${VCPKG_INSTALLED_PATH}/lib"
      REQUIRED)
    add_library(ggml::${_backend} SHARED IMPORTED)
    set_target_properties(ggml::${_backend} PROPERTIES
      IMPORTED_LOCATION "${_${_backend}_LIB}"
      IMPORTED_NO_SONAME TRUE)
    list(APPEND BACKEND_DL_EXPORTS INSTALL TARGET ggml::${_backend})
  endforeach()
endif()

add_bare_module(qvac-lib-inference-addon-sd EXPORTS ${BACKEND_DL_EXPORTS})
  set(ADDON_SOURCES
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/handlers/SdCtxHandlers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/handlers/SdGenHandlers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/SdModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
  )

  target_sources(
    ${qvac-lib-inference-addon-sd}
    PRIVATE
      ${ADDON_SOURCES}
  )

  target_include_directories(
    ${qvac-lib-inference-addon-sd}
    PRIVATE
      ${PICOJSON_INCLUDE_DIRS}
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
      ${STB_IMAGE_WRITE_INCLUDE_DIR}
      ${PROJECT_SOURCE_DIR}/addon/src
  )

  target_link_libraries(
    ${qvac-lib-inference-addon-sd}
    PRIVATE
      stable-diffusion::stable-diffusion
  )

target_compile_features(${qvac-lib-inference-addon-sd} PRIVATE cxx_std_20)
target_compile_definitions(${qvac-lib-inference-addon-sd} PUBLIC JS_LOGGER)
target_compile_definitions(${qvac-lib-inference-addon-sd} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

if(GGML_BACKEND_DL)
  target_compile_definitions(${qvac-lib-inference-addon-sd} PRIVATE GGML_BACKEND_DL)
endif()

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)
endif()

if(WIN32)
  target_link_libraries(
    ${qvac-lib-inference-addon-sd}
    PRIVATE
      msvcrt.lib
  )
endif()


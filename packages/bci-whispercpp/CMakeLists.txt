cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

# Prepend the local overlay triplets on every platform and preserve any
# externally-set value (matches the other qvac addons). Only the Linux
# triplets actually differ from vcpkg's defaults today, but exposing the
# directory uniformly avoids platform-conditional surprises.
set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(bci-whispercpp CXX C)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/ModelInterfaces.hpp")
find_package(whisper CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI)
endif()

# Subdir bare's runtime installs the dlopen-able backend modules into
# (<addon>/prebuilds/<bare_target>/<module_name>/); BCIModel joins it
# with the runtime-supplied backendsDir before
# ggml_backend_load_all_from_path(). Mirrors transcription-whispercpp.
bare_target(bare_target_value)
bare_module_target("." _unused_target NAME module_name VERSION _unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")

# Collect every dynamically-loadable ggml backend that the `ggml-speech`
# port produced ($CURRENT_PACKAGES_DIR/lib/libqvac-speech-ggml-*.so on
# Android; nothing on Apple/static-only platforms). Mirrors
# qvac/packages/transcription-whispercpp/CMakeLists.txt verbatim --
# two branches:
#   1. IMPORTED targets that `find_package(ggml)` already surfaced
#      (CPU on Android, all backends on Linux desktop).
#   2. Loose `libqvac-speech-ggml-*.so` MODULE files that ggml-config
#      deliberately omits from GGML_AVAILABLE_BACKENDS' IMPORTED set
#      (Vulkan + OpenCL on Android -- the loader picks them up at
#      runtime via `ggml_backend_load_all_from_path()`).
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    if(TARGET ggml::${_backend})
      list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
    endif()
  endforeach()
endif()

set(BACKEND_DL_LOOSE_SOS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  if(NOT VCPKG_INSTALLED_PATH OR NOT EXISTS "${VCPKG_INSTALLED_PATH}/lib")
    message(WARNING "bci-whispercpp: VCPKG_INSTALLED_PATH "
      "('${VCPKG_INSTALLED_PATH}') has no lib/ dir; skipping loose "
      "ggml backend .so pickup -- the runtime may fail to find "
      "Vulkan / OpenCL backends.")
  else()
    file(GLOB BACKEND_DL_LOOSE_SOS
      "${VCPKG_INSTALLED_PATH}/lib/libqvac-speech-ggml-*.so")
    foreach(_lib IN LISTS BACKEND_DL_LOOSE_SOS)
      message(STATUS "bci-whispercpp: will stage ggml backend ${_lib}")
    endforeach()
  endif()
endif()

add_bare_module(bci-whispercpp EXPORTS ${BACKEND_DL_LIBS})

# Stage every loose MODULE backend (Vulkan / OpenCL on Android, ...)
# into the same per-host/per-module subdir cmake-bare's INSTALL TARGET
# branch uses for IMPORTED targets -- keeping destinations identical so
# `ggml_backend_load_all_from_path(backendsDir / BACKENDS_SUBDIR)`
# discovers IMPORTED-target CPU + loose-file GPU backends in one scan.
if(BACKEND_DL_LOOSE_SOS)
  install(
    FILES ${BACKEND_DL_LOOSE_SOS}
    DESTINATION ${bare_target_value}/${module_name}
  )
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${bci-whispercpp}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${bci-whispercpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/BCIConfig.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/BCIModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/NeuralProcessor.cpp
)

target_include_directories(
  ${bci-whispercpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${bci-whispercpp}
  PRIVATE
    whisper::whisper
)

target_compile_definitions(${bci-whispercpp} PUBLIC JS_LOGGER)
target_compile_definitions(${bci-whispercpp} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")
if(BUILD_TESTING)
  find_package(GTest REQUIRED)

  set(CORE_SRCS
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/BCIConfig.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/BCIModel.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/NeuralProcessor.cpp
  )

  add_library(bci-core STATIC ${CORE_SRCS})

  target_link_libraries(bci-core PRIVATE
      whisper::whisper
  )

  target_include_directories(bci-core PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/
      ${PROJECT_SOURCE_DIR}/addon/src/
      ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  add_executable(
      test-bci-core
      ${PROJECT_SOURCE_DIR}/addon/tests/test_core.cpp
  )

  target_include_directories(test-bci-core PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/
      ${PROJECT_SOURCE_DIR}/addon/src/
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/
      ${PROJECT_SOURCE_DIR}/addon/tests/
      ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  target_link_libraries(test-bci-core PRIVATE
      bci-core
      whisper::whisper
      GTest::gtest_main
      GTest::gmock
  )

  set_target_properties(test-bci-core PROPERTIES
      RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/addon/tests
  )

  if(ENABLE_COVERAGE)
      target_compile_options(test-bci-core PRIVATE
          -fprofile-instr-generate
          -fcoverage-mapping
      )
      target_compile_options(bci-core PRIVATE
          -fprofile-instr-generate
          -fcoverage-mapping
      )
      target_link_options(test-bci-core PRIVATE
          -fprofile-instr-generate
      )
      message(STATUS "LLVM Coverage enabled for bci-core tests")
  endif()
endif()

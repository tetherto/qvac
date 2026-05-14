cmake_minimum_required(VERSION 3.25)

option(ANDROID_STL "Android STL linkage" c++_shared)
option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_COVERAGE "Enable coverage" OFF)
option(ENABLE_VULKAN "Enable Vulkan GPU acceleration" OFF)

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

if(ENABLE_VULKAN)
  list(APPEND VCPKG_MANIFEST_FEATURES "vulkan")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(tts-ggml CXX C)

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
configure_file(${VCPKG_INSTALLED_PATH}/tools/lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/ModelInterfaces.hpp")
find_package(tts-cpp CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI)
endif()

# On Android with GGML_BACKEND_DL, install all ggml backend .so modules
# alongside the addon so ggml can dlopen them at runtime. The local overlay
# of the ggml-speech port drops GGML_CPU_STATIC so the CPU backend is also a
# MODULE .so (no static cpu code linked into the addon).
set(BACKEND_DL_EXPORTS "")
if(ANDROID AND GGML_BACKEND_DL)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    string(REPLACE "-" "_" _backend_target_suffix "${_backend}")
    find_library(_${_backend_target_suffix}_LIB NAMES
      "qvac-speech-${_backend}"
      "${_backend}"
      PATHS
        "${VCPKG_INSTALLED_PATH}/bin"
        "${VCPKG_INSTALLED_PATH}/lib"
      REQUIRED)

    add_library(qvac_speech_${_backend_target_suffix} SHARED IMPORTED)
    set_target_properties(qvac_speech_${_backend_target_suffix} PROPERTIES
      IMPORTED_LOCATION "${_${_backend_target_suffix}_LIB}"
      IMPORTED_NO_SONAME TRUE)
    list(APPEND BACKEND_DL_EXPORTS INSTALL TARGET qvac_speech_${_backend_target_suffix})
  endforeach()
endif()

add_bare_module(tts-ggml EXPORTS ${BACKEND_DL_EXPORTS})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${tts-ggml}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${tts-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/chatterbox/ChatterboxModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/supertonic/SupertonicModel.cpp
)

target_include_directories(
  ${tts-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${tts-ggml}
  PRIVATE
    tts-cpp::tts-cpp
)

target_compile_definitions(${tts-ggml} PUBLIC JS_LOGGER)

if(WIN32)
  target_link_libraries(
    ${tts-ggml}
    PRIVATE
      msvcrt.lib
  )
endif()

if(BUILD_TESTING)
  enable_testing()
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)

  # Test exec recompiles ChatterboxModel.cpp + SupertonicModel.cpp from
  # source (rather than linking the bare-module artefact) so coverage
  # instrumentation lands on those translation units.  JSAdapter.cpp is
  # excluded because it depends on Bare's <js.h>, which isn't available
  # outside the bare module link.
  add_executable(
    tts_ggml_tests
      addon/tests/test_backend_utils.cpp
      addon/tests/test_chatterbox_config.cpp
      addon/tests/test_supertonic_config.cpp
      addon/tests/AddonCppTest.cpp
      addon/src/model-interface/chatterbox/ChatterboxModel.cpp
      addon/src/model-interface/supertonic/SupertonicModel.cpp
  )

  target_include_directories(tts_ggml_tests
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon
      ${PROJECT_SOURCE_DIR}/addon/src
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  target_link_libraries(tts_ggml_tests
    PRIVATE
      GTest::gmock_main
      tts-cpp::tts-cpp
  )

  if(WIN32)
    target_link_libraries(tts_ggml_tests PRIVATE msvcrt.lib)
  endif()

  if(ENABLE_COVERAGE)
    # LLVM source-based coverage (clang).  Same flag set parakeet uses.
    target_compile_options(tts_ggml_tests PRIVATE
      -fprofile-instr-generate
      -fcoverage-mapping
    )
    target_link_options(tts_ggml_tests PRIVATE
      -fprofile-instr-generate
    )
    message(STATUS "LLVM Coverage enabled for tts-ggml tests")
  endif()

  # CI invokes the test binary directly via npm scripts (so it can pass
  # gtest_output= and capture results.xml); avoid running the binary
  # during configure-time discovery to keep configure cheap.
  add_test(NAME tts_ggml_tests COMMAND tts_ggml_tests)
endif()

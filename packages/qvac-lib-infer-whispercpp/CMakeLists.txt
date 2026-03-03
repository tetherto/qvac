cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
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

project(qvac-lib-infer-whispercpp CXX C)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/tools/qvac-lint-cpp/hooks/pre-commit
               ${CMAKE_CURRENT_SOURCE_DIR}/.git/hooks/pre-commit COPYONLY)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/Addon.hpp")
find_package(whisper CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Define _DEBUG for debug builds
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

if(WIN32)
  add_definitions( -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI )
endif()

# Required by Tokenizers
if(ANDROID)
  set(ANDROID_TOOLCHAIN_ROOT "$ENV{ANDROID_TOOLCHAIN_ROOT}")
  set(ANDROID_NATIVE_API_LEVEL "$ENV{ANDROID_NATIVE_API_LEVEL}")
endif()

add_bare_module(qvac-lib-infer-whispercpp EXPORTS)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${qvac-lib-infer-whispercpp}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${qvac-lib-infer-whispercpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/addon/Addon.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/addon/WhisperModelJobsHandler.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/qvac-lib-infer-whispercpp.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperConfig.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperHandlers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperHandlers.hpp
)

target_include_directories(
  ${qvac-lib-infer-whispercpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${qvac-lib-infer-whispercpp}
  PRIVATE
    whisper::whisper
)

target_compile_definitions(${qvac-lib-infer-whispercpp} PUBLIC JS_LOGGER)

if(WIN32)
  target_link_libraries(
    ${qvac-lib-infer-whispercpp}
    PRIVATE
      msvcrt.lib
  )
endif()

if(BUILD_TESTING)
  find_package(GTest REQUIRED)

  # Create whisper-core library for testing
  set(CORE_SRCS
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperConfig.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperModel.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperHandlers.cpp
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/WhisperHandlers.hpp
  )

  add_library(whisper-core STATIC ${CORE_SRCS})

  target_link_libraries(whisper-core PRIVATE
      whisper::whisper
  )

  target_include_directories(whisper-core PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/src/
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  # Only define JS_LOGGER for tests if coverage is not enabled
  # (Coverage tests need pure C++ without JavaScript/libuv dependencies)
  if(NOT ENABLE_COVERAGE)
    target_compile_definitions(whisper-core PUBLIC JS_LOGGER)
  endif()

  # Create test executable
  add_executable(test-whisper-core ${PROJECT_SOURCE_DIR}/addon/tests/test_core.cpp)

  target_include_directories(test-whisper-core PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper.cpp/
      ${PROJECT_SOURCE_DIR}/addon/src/
      ${PROJECT_SOURCE_DIR}/addon/tests/
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  target_link_libraries(test-whisper-core PRIVATE 
      whisper-core 
      whisper::whisper 
      GTest::gtest_main 
      GTest::gmock
  )

  # Set the output directory for test executable
  set_target_properties(test-whisper-core PROPERTIES
      RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/addon/tests
  )

  # Coverage configuration
  if(ENABLE_COVERAGE)
      # Use LLVM coverage flags
      target_compile_options(test-whisper-core PRIVATE 
          -fprofile-instr-generate 
          -fcoverage-mapping
      )
      target_compile_options(whisper-core PRIVATE 
          -fprofile-instr-generate 
          -fcoverage-mapping
      )
      # Link against LLVM profile runtime
      target_link_options(test-whisper-core PRIVATE 
          -fprofile-instr-generate
      )
      message(STATUS "LLVM Coverage enabled for whisper-core tests")
  endif()
endif()
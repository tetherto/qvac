cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_XNNPACK "Enable XNNPack execution provider" ON)

# Force Apple Clang instead of Homebrew LLVM
if(APPLE)
  message(STATUS "enter special apple")
  # Force Apple Clang from Xcode, not Homebrew
  execute_process(
    COMMAND xcrun --find clang
    OUTPUT_VARIABLE XCODE_CLANG
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )
  execute_process(
    COMMAND xcrun --find clang++
    OUTPUT_VARIABLE XCODE_CLANGXX
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )

  set(CMAKE_C_COMPILER   ${XCODE_CLANG}   CACHE FILEPATH "Apple Clang C compiler" FORCE)
  set(CMAKE_CXX_COMPILER ${XCODE_CLANGXX} CACHE FILEPATH "Apple Clang C++ compiler" FORCE)

  # Device SDK
  execute_process(
    COMMAND xcrun --sdk iphoneos --show-sdk-path
    OUTPUT_VARIABLE IOS_SDK
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )
  # Simulator SDK
  execute_process(
    COMMAND xcrun --sdk iphonesimulator --show-sdk-path
    OUTPUT_VARIABLE SIM_SDK
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )
  # macOS SDK
  execute_process(
    COMMAND xcrun --sdk macosx --show-sdk-path
    OUTPUT_VARIABLE MACOS_SDK
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )

  message(STATUS "Apple target arch: ${APPLE_ARCH}")
  message(STATUS "macOS SDK path: ${MACOS_SDK}")
  message(STATUS "iOS SDK path:   ${IOS_SDK}")
  message(STATUS "Sim SDK path:   ${SIM_SDK}")

  # Choose sysroot depending on CMake hint
  if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    set(CMAKE_OSX_SYSROOT ${IOS_SDK})
    set(CMAKE_SYSTEM_PROCESSOR arm64)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "16.3")
  elseif(CMAKE_SYSTEM_NAME STREQUAL "iOSSimulator")
    set(CMAKE_OSX_SYSROOT ${SIM_SDK})
    set(CMAKE_SYSTEM_PROCESSOR ${APPLE_ARCH})
    set(CMAKE_OSX_DEPLOYMENT_TARGET "16.3")
  else() # Darwin/macOS host
    set(CMAKE_OSX_SYSROOT ${MACOS_SDK})
    set(CMAKE_SYSTEM_NAME Darwin)
    set(CMAKE_SYSTEM_PROCESSOR ${APPLE_ARCH})
    set(CMAKE_OSX_DEPLOYMENT_TARGET "13.3")
  endif()
endif()

if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

if(ENABLE_XNNPACK)
  list(APPEND VCPKG_MANIFEST_FEATURES "xnnpack")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

# Enable overlay triplets for release-only builds (excludes Windows)
if(APPLE OR UNIX)
  message("VCPKG_OVERLAY_TRIPLETS override: vcpkg-override-triplets/triplets")
  SET(VCPKG_OVERLAY_TRIPLETS "vcpkg-override-triplets/triplets")
endif()

set(VCPKG_INSTALL_OPTIONS --clean-after-build)

project(qvac-onnx
  VERSION 1.0.0
  LANGUAGES C CXX)

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.valgrind.supp
               ${CMAKE_CURRENT_SOURCE_DIR}/.valgrind.supp COPYONLY)

include(CTest)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Note: We use a linker version script (symbols.map) to hide internal symbols
# instead of visibility presets, so that bare_* symbols remain exportable.

find_package(unofficial-pthreadpool CONFIG QUIET)
find_package(onnxruntime CONFIG REQUIRED)

add_bare_module(qvac-onnx EXPORTS)

target_sources(
  ${qvac-onnx}
  PRIVATE
    addon/binding.cpp
)
target_include_directories(
  ${qvac-onnx}
  PRIVATE
    src
)
target_link_libraries(
  ${qvac-onnx}
  PRIVATE
    onnxruntime::onnxruntime_static
)

# Use version script to hide internal symbols (including ONNX runtime)
# This prevents symbol conflicts when multiple ONNX-based addons are loaded
# Note: We target the _module shared library, not the object library
if(UNIX AND NOT APPLE)
  target_link_options(
    ${qvac-onnx}_module
    PRIVATE
      -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/symbols.map
  )
elseif(APPLE)
  # macOS uses -exported_symbols_list instead of version script
  target_link_options(
    ${qvac-onnx}_module
    PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )
endif()

function(strip_libraries LIB_DIR LIB_NAMES)
  foreach(LIB_NAME IN LISTS LIB_NAMES)
    set(LIB_PATH "${LIB_DIR}/${LIB_NAME}")

    execute_process(
      COMMAND ${LLVM_STRIP} --strip-debug "${LIB_PATH}"
      ERROR_VARIABLE STRIP_ERROR
    )
    message("-- Stripping ${LIB_PATH} errorCode: ${STRIP_ERROR}")
  endforeach()
endfunction()

if(ANDROID)
  find_package(Vulkan REQUIRED)
  target_link_libraries(${qvac-onnx} PRIVATE ${Vulkan_LIBRARY} log)

  # Strip vcpkg installed binaries for Android builds
  find_program(LLVM_STRIP llvm-strip)

  if(NOT LLVM_STRIP)
    message(WARNING "-- llvm-strip not found. Skipping library stripping for Android build.")
  else()
    message("-- llvm-strip found: ${LLVM_STRIP}")
    set(LIBRARIES_TO_STRIP_IN_LIB_DIR libonnx.a libprotobuf.a libprotoc.a)

    set(VCPKG_INSTALLED_DIR "${CMAKE_BINARY_DIR}/_vcpkg/${VCPKG_TARGET_TRIPLET}")
    set(LIBS_DIR_PATH "${VCPKG_INSTALLED_DIR}/lib")

    strip_libraries(${LIBS_DIR_PATH} "${LIBRARIES_TO_STRIP_IN_LIB_DIR}")
  endif()
endif()

if(WIN32)
  target_compile_options(${qvac-onnx} PRIVATE "/utf-8")

  target_compile_definitions(${qvac-onnx} PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX NOGDI)

  target_link_libraries(
    ${qvac-onnx}
    PRIVATE
      msvcrt.lib
  )
endif()

if(BUILD_TESTING)
    find_package(GTest CONFIG REQUIRED)
    include(GoogleTest)
    enable_testing()

    # Unit tests: ORT-free (config, tensor types, interface mock)
    add_executable(
        unit_tests
        tests/tensor_types_test.cpp
        tests/config_test.cpp
        tests/interface_test.cpp
    )
    target_include_directories(unit_tests PRIVATE src)
    target_link_libraries(unit_tests PRIVATE GTest::gmock_main)
    gtest_discover_tests(unit_tests)

    # ORT tests: require ONNX Runtime (runtime singleton, type conversions,
    # session options, session integration with test model fixtures)
    add_executable(
        ort_tests
        tests/runtime_test.cpp
        tests/type_conversions_test.cpp
        tests/session_options_test.cpp
        tests/session_test.cpp
        tests/addon_shared_runtime_test.cpp
    )
    target_include_directories(ort_tests PRIVATE
        src
    )
    target_compile_definitions(ort_tests PRIVATE
        TEST_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
    target_link_libraries(ort_tests PRIVATE
        GTest::gmock_main
        onnxruntime::onnxruntime_static)
    gtest_discover_tests(ort_tests)
endif()

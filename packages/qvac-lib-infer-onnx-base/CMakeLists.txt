cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build tests" OFF)

# Force Apple Clang instead of Homebrew LLVM
if(APPLE)
  message(STATUS "Configuring for Apple platform")
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

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

# Enable overlay triplets for release-only builds (excludes Windows)
if(APPLE OR UNIX)
  message("VCPKG_OVERLAY_TRIPLETS override: vcpkg-override-triplets/triplets")
  SET(VCPKG_OVERLAY_TRIPLETS "vcpkg-override-triplets/triplets")
endif()

set(VCPKG_INSTALL_OPTIONS --clean-after-build)

project(
  onnx-addon
  VERSION 0.1.0
  LANGUAGES C CXX)

include(CTest)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Note: We use a linker version script (symbols.map) to hide internal symbols
# instead of visibility presets, so that bare_* symbols remain exportable.

find_package(onnxruntime CONFIG REQUIRED)

add_bare_module(onnx-addon EXPORTS)

target_sources(
  ${onnx-addon}
  PRIVATE
    addon/OnnxSession.cpp
    addon/js-interface/binding.cpp
    addon/js-interface/JsOnnxSession.cpp
)

target_include_directories(
  ${onnx-addon}
  PRIVATE
    addon
)

target_link_libraries(
  ${onnx-addon}
  PRIVATE
    onnxruntime::onnxruntime_static
)

# Use version script to hide internal symbols (including ONNX runtime)
# This prevents symbol conflicts when multiple ONNX-based addons are loaded
# Note: We target the _module shared library, not the object library
if(UNIX AND NOT APPLE)
  target_link_options(
    ${onnx-addon}_module
    PRIVATE
      -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/symbols.map
  )
elseif(APPLE)
  # macOS uses -exported_symbols_list instead of version script
  target_link_options(
    ${onnx-addon}_module
    PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )
endif()

if(ANDROID)
  find_package(Vulkan REQUIRED)
  target_link_libraries(${onnx-addon} PRIVATE ${Vulkan_LIBRARY} log)
endif()

if(WIN32)
  target_compile_options(${onnx-addon} PRIVATE "/utf-8")
  target_compile_definitions(${onnx-addon} PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX NOGDI)
  target_link_libraries(${onnx-addon} PRIVATE msvcrt.lib)
endif()

# Install headers for other addons to consume
# Note: We install OnnxTensor.hpp and IOnnxSession.hpp for external addons.
# External addons should use IOnnxSession* (interface) for virtual dispatch.
# JsOnnxSession.hpp is NOT installed here - a separate inline version
# exists in prebuilds/include for external addons to use without linking.
install(FILES
    addon/OnnxConfig.hpp
    addon/OnnxTensor.hpp
    addon/IOnnxSession.hpp
    addon/OnnxSession.hpp
    DESTINATION include/onnx-addon
)

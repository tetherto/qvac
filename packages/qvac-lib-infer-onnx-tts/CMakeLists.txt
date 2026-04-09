cmake_minimum_required(VERSION 3.25)

option(BUILD_TESTING "Build unit tests" OFF)
option(ENABLE_COVERAGE "Enable coverage" OFF)
option(MOBILE_DYNAMIC_LINK "Use dynamic linking for ONNX Runtime on mobile" ON)

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

  # Detect which target we are building
  if(CMAKE_OSX_ARCHITECTURES STREQUAL "arm64" OR CMAKE_SYSTEM_PROCESSOR STREQUAL "arm64")
    set(APPLE_ARCH "arm64")
  else()
    set(APPLE_ARCH "x86_64")
  endif()

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
    if(DEFINED IOS_SIMULATOR OR DEFINED ENV{SIMULATOR_DEVICE_NAME} OR
       CMAKE_OSX_SYSROOT MATCHES "iphonesimulator" OR
       CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64")
      message(STATUS "Detected iOS Simulator build")
      execute_process(
        COMMAND xcrun --sdk iphonesimulator --show-sdk-path
        OUTPUT_VARIABLE IOS_SIM_SDK
        OUTPUT_STRIP_TRAILING_WHITESPACE
      )
      set(CMAKE_OSX_SYSROOT ${IOS_SIM_SDK})
      set(CMAKE_SYSTEM_PROCESSOR ${APPLE_ARCH})
      set(CMAKE_OSX_DEPLOYMENT_TARGET "16.0")
    else()
      message(STATUS "Detected iOS Device build")
      execute_process(
        COMMAND xcrun --sdk iphoneos --show-sdk-path
        OUTPUT_VARIABLE IOS_DEV_SDK
        OUTPUT_STRIP_TRAILING_WHITESPACE
      )
      set(CMAKE_OSX_SYSROOT ${IOS_DEV_SDK})
      set(CMAKE_SYSTEM_PROCESSOR arm64)
      set(CMAKE_OSX_DEPLOYMENT_TARGET "16.0")
    endif()
  else()
    message(STATUS "Detected macOS build")
    execute_process(
      COMMAND xcrun --sdk macosx --show-sdk-path
      OUTPUT_VARIABLE MAC_SDK
      OUTPUT_STRIP_TRAILING_WHITESPACE
    )
    set(CMAKE_OSX_SYSROOT ${MAC_SDK})
    set(CMAKE_SYSTEM_NAME Darwin)
    set(CMAKE_SYSTEM_PROCESSOR ${APPLE_ARCH})
    set(CMAKE_OSX_DEPLOYMENT_TARGET "16.0")
  endif()
endif()

if(BUILD_TESTING)
  message("BUILD_TESTING is enabled")
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

if(ENABLE_COVERAGE)
  message("ENABLE_COVERAGE is enabled")
  if(NOT BUILD_TESTING)
    message(FATAL_ERROR "BUILD_TESTING is required when ENABLE_COVERAGE is enabled")
  endif()
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")
if(APPLE)
  SET(VCPKG_OVERLAY_PORTS "vcpkg-overlay-ports")
endif()

project(qvac-lib-inference-tts C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(WIN32)
  add_definitions( -DWIN32_LEAN_AND_MEAN -DNOMINMAX -DNOGDI )
endif()

set(qvac-onnx_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/onnx/prebuilds/share/qvac-onnx/cmake")
find_package(qvac-onnx CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(unofficial-utf8proc CONFIG REQUIRED)
if(TARGET utf8proc::utf8proc)
  set(QVAC_UTF8PROC_TARGET utf8proc::utf8proc)
elseif(TARGET utf8proc)
  set(QVAC_UTF8PROC_TARGET utf8proc)
else()
  message(FATAL_ERROR "utf8proc CMake target missing (expected from unofficial-utf8proc)")
endif()

add_bare_module(qvac-lib-inference-tts EXPORTS)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${qvac-lib-inference-tts}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${qvac-lib-inference-tts}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TTSModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ChatterboxEngine.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ChatterboxTextPreprocessor.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/OnnxInferSession.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/SupertonicEngine.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/Fp16Utils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TensorFloatHandler.cpp
)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/RuntimeStats.hpp")
find_package(tokenizers_cpp CONFIG REQUIRED)

target_include_directories(
  ${qvac-lib-inference-tts}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

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
  target_link_libraries(${qvac-lib-inference-tts} PRIVATE ${Vulkan_LIBRARY})
  
  # Strip vcpkg installed binaries for Android builds
  find_program(LLVM_STRIP llvm-strip)

  if(NOT LLVM_STRIP)
    message(WARNING "-- llvm-strip not found. Skipping library stripping for Android build.")
  else()
    message("-- llvm-strip found: ${LLVM_STRIP}")
    set(LIBRARIES_TO_STRIP libonnx.a libprotobuf.a libprotoc.a libflatbuffers.a libprotobuf-lite.a libre2.a)

    set(VCPKG_INSTALLED_DIR "${CMAKE_BINARY_DIR}/_vcpkg/${VCPKG_TARGET_TRIPLET}")
    set(LIBS_DIR_PATH "${VCPKG_INSTALLED_DIR}/lib")

    strip_libraries(${LIBS_DIR_PATH} "${LIBRARIES_TO_STRIP}")
  endif()
endif()

if((ANDROID OR (APPLE AND CMAKE_SYSTEM_NAME STREQUAL "iOS")) AND NOT MOBILE_DYNAMIC_LINK)
  target_link_libraries(
    ${qvac-lib-inference-tts}
    PRIVATE
      qvac-onnx::qvac-onnx-static
      tokenizers::tokenizers_cpp
      nlohmann_json::nlohmann_json
      ${QVAC_UTF8PROC_TARGET}
  )
else()
  include_bare_module("@qvac/onnx" qvac_onnx_target PREBUILD)

  target_link_libraries(
    ${qvac-lib-inference-tts}
    PRIVATE
      qvac-onnx::headers
      tokenizers::tokenizers_cpp
      nlohmann_json::nlohmann_json
      ${QVAC_UTF8PROC_TARGET}
  )
  target_link_libraries(
    ${qvac-lib-inference-tts}_module
    PRIVATE
      ${qvac_onnx_target}_module
  )

  bare_target(host)
  bare_module_target("." _unused NAME addon_name)
  install(FILES $<TARGET_FILE:${qvac_onnx_target}_module>
    DESTINATION ${host}/${addon_name}
    RENAME qvac__onnx@0.bare)
endif()

if(APPLE)
  set_target_properties(
    ${qvac-lib-inference-tts}
    PROPERTIES
      BUILD_RPATH "@loader_path"
      INSTALL_RPATH "@loader_path"
      MACOSX_RPATH ON
  )
  target_link_options(
    ${qvac-lib-inference-tts}
    PRIVATE "-Wl,-rpath,@loader_path"
  )
endif()

if(WIN32)
  target_link_libraries(
    ${qvac-lib-inference-tts}
    PRIVATE
      msvcrt.lib
  )
endif()

if(UNIX AND NOT APPLE)
  target_link_options(
    ${qvac-lib-inference-tts}_module
    PRIVATE
      -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/symbols.map
  )
elseif(APPLE)
  # macOS uses -exported_symbols_list instead of version script
  target_link_options(
    ${qvac-lib-inference-tts}_module
    PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )
endif()

target_compile_definitions(${qvac-lib-inference-tts} PUBLIC JS_LOGGER)

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(addon/test/unit)
endif()

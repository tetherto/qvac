cmake_minimum_required(VERSION 3.25)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_package(onnxruntime CONFIG REQUIRED)

# TODO: Configure for x64 Apple and iOS/Android
if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
  set(TARGET_ARCH "aarch64")
elseif(CMAKE_SYSTEM_PROCESSOR STREQUAL "i686")
  set(TARGET_ARCH "i686")
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|x64|AMD64")
  set(TARGET_ARCH "x86_64")
else()
  message(FATAL_ERROR "Unsupported target architecture: ${CMAKE_SYSTEM_PROCESSOR}")
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Android")
  set(PLATFORM "linux-android")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  set(PLATFORM "apple-darwin")
elseif(CMAKE_SYSTEM_NAME STREQUAL "iOS")
  set(PLATFORM "apple-ios")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(PLATFORM "unknown-linux-gnu")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows")
  set(PLATFORM "pc-windows-msvc")
else()
  message(FATAL_ERROR "Unsupported target system: ${CMAKE_SYSTEM_NAME}")
endif()

set(LIB_NAME silero_vad)
set(SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/SileroVadIterator.hpp
            ${CMAKE_CURRENT_SOURCE_DIR}/SileroVadIterator.cpp)

add_library(${LIB_NAME} STATIC ${SOURCES})

target_include_directories(
  ${LIB_NAME}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(${LIB_NAME} PRIVATE onnxruntime::onnxruntime_static)


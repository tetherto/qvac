message(STATUS "arm64-ios loading custom iOS triplet configuration...")
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME iOS)

execute_process(
  COMMAND xcrun --find clang
  OUTPUT_VARIABLE APPLE_CLANG_C
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
execute_process(
  COMMAND xcrun --find clang++
  OUTPUT_VARIABLE APPLE_CLANG_CXX
  OUTPUT_STRIP_TRAILING_WHITESPACE
)

if(EXISTS "${APPLE_CLANG_CXX}")
  message(STATUS "arm64-ios Using Apple Clang from Xcode: ${APPLE_CLANG_CXX}")
  set(CMAKE_C_COMPILER "${APPLE_CLANG_C}")
  set(CMAKE_CXX_COMPILER "${APPLE_CLANG_CXX}")
else()
  message(WARNING "arm64-ios  Apple Clang not found via xcrun — fallback to system clang.")
endif()

execute_process(
  COMMAND xcrun --sdk iphoneos --show-sdk-path
  OUTPUT_VARIABLE IOS_SDK_PATH
  OUTPUT_STRIP_TRAILING_WHITESPACE
)

if(EXISTS "${IOS_SDK_PATH}")
  message(STATUS "arm64-ios Using iPhoneOS SDK path: ${IOS_SDK_PATH}")
  set(CMAKE_OSX_SYSROOT "${IOS_SDK_PATH}")
else()
  message(WARNING "arm64-ios Could not resolve iPhoneOS SDK — using default CMake sysroot.")
endif()

set(CMAKE_OSX_DEPLOYMENT_TARGET 16.0)
set(VCPKG_OSX_DEPLOYMENT_TARGET 16.0)

message(STATUS "arm64-ios iOS Deployment Target set to: ${CMAKE_OSX_DEPLOYMENT_TARGET}")

message(STATUS "---------------------------------------------")
message(STATUS "arm64-ios Final Configuration Summary:")
message(STATUS "  Compiler (C):   ${CMAKE_C_COMPILER}")
message(STATUS "  Compiler (CXX): ${CMAKE_CXX_COMPILER}")
message(STATUS "  SDK Root:       ${CMAKE_OSX_SYSROOT}")
message(STATUS "  Target:         arm64-apple-ios${CMAKE_OSX_DEPLOYMENT_TARGET}")
message(STATUS "---------------------------------------------")

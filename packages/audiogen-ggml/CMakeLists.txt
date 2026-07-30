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

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(audiogen-ggml CXX C)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/ModelInterfaces.hpp")
find_package(audiogen-cpp CONFIG REQUIRED)
# Pull ggml in directly (in addition to the transitive find via
# audiogen-cppConfig) so GGML_AVAILABLE_BACKENDS / ggml::<backend> IMPORTED
# targets are visible for the dynamic-backend install plumbing below
# (mirrors tts-ggml).
find_package(ggml CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI)
endif()

# Per-host/per-module subdir for dynamically-loadable ggml backends
# (same shape tts-ggml / transcription-parakeet use).
bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")

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
  if(VCPKG_INSTALLED_PATH AND EXISTS "${VCPKG_INSTALLED_PATH}/lib")
    file(GLOB BACKEND_DL_LOOSE_SOS
      "${VCPKG_INSTALLED_PATH}/lib/libqvac-speech-ggml-*.so")
  endif()
endif()

add_bare_module(audiogen-ggml EXPORTS ${BACKEND_DL_LIBS})

if(BACKEND_DL_LOOSE_SOS)
  install(
    FILES ${BACKEND_DL_LOOSE_SOS}
    DESTINATION ${bare_target_value}/${module_name}
  )
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${audiogen-ggml}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${audiogen-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/acestep/AcestepModel.cpp
)

target_include_directories(
  ${audiogen-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${audiogen-ggml}
  PRIVATE
    audiogen-cpp::audiogen-cpp
)

target_compile_definitions(${audiogen-ggml} PUBLIC JS_LOGGER)
target_compile_definitions(${audiogen-ggml} PRIVATE
  BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

if(ANDROID)
  target_link_options(
    ${audiogen-ggml}_module
    PRIVATE
      -Wl,-z,max-page-size=16384
      -Wl,-z,common-page-size=16384
  )
endif()

if(APPLE)
  target_link_options(
    ${audiogen-ggml}_module
    PRIVATE
      -Wl,-exported_symbol,_bare_get_module_name_v0
      -Wl,-exported_symbol,_bare_register_module_v0
  )
endif()

# iOS: the bare module is linked with `-undefined dynamic_lookup`, which lets
# ObjC/Metal/libc++ symbols resolve at load time against the OS dylibs. But the
# clang compiler-rt builtin `___isPlatformVersionAtLeast` (emitted by ggml-metal's
# `@available(iOS 16, *)` checks, since the deployment target is < 16) lives only
# in the static libclang_rt archive, not in any dylib. Under dynamic_lookup it
# stays unresolved -> its stub jumps to 0x0 -> the kernel kills the process with a
# "CODESIGNING Invalid Page" fault the moment Metal initialises. Explicitly link
# the compiler-rt builtins so that symbol (and any other builtin) is defined.
if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
  # Resolve the clang resource dir via xcrun (CMAKE_C_COMPILER is a cross wrapper
  # here and doesn't reliably answer -print-resource-dir).
  execute_process(
    COMMAND xcrun --find clang
    OUTPUT_VARIABLE _xcrun_clang
    OUTPUT_STRIP_TRAILING_WHITESPACE)
  execute_process(
    COMMAND ${_xcrun_clang} -print-resource-dir
    OUTPUT_VARIABLE _clang_resource_dir
    OUTPUT_STRIP_TRAILING_WHITESPACE)
  if(CMAKE_OSX_SYSROOT MATCHES "[Ss]imulator")
    set(_clang_rt_builtins "${_clang_resource_dir}/lib/darwin/libclang_rt.iossim.a")
  else()
    set(_clang_rt_builtins "${_clang_resource_dir}/lib/darwin/libclang_rt.ios.a")
  endif()
  if(EXISTS "${_clang_rt_builtins}")
    message(STATUS "audiogen-ggml: linking compiler-rt builtins: ${_clang_rt_builtins}")
    target_link_libraries(${audiogen-ggml}_module PRIVATE "${_clang_rt_builtins}")
  else()
    message(WARNING "audiogen-ggml: compiler-rt builtins not found at ${_clang_rt_builtins}")
  endif()
endif()

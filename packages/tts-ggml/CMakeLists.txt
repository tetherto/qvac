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

project(tts-ggml CXX C)

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

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp")
find_package(qvac-tts-cpp CONFIG REQUIRED)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

if(WIN32)
  add_definitions(-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI)
endif()

add_bare_module(tts-ggml EXPORTS)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${tts-ggml}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

target_sources(
  ${tts-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/chatterbox/ChatterboxModel.cpp
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
    qvac-tts::qvac-tts
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
  find_package(GTest REQUIRED)

  # Expose the non-JS engine bits as a static library so the upcoming gtest
  # suite (ported from qvac-lib-infer-onnx-tts/addon/test/unit) can link
  # against ChatterboxModel directly without pulling in the bare addon.
  set(CORE_SRCS
      ${PROJECT_SOURCE_DIR}/addon/src/model-interface/chatterbox/ChatterboxModel.cpp
  )

  add_library(tts-ggml-core STATIC ${CORE_SRCS})

  target_link_libraries(tts-ggml-core PRIVATE qvac-tts::qvac-tts)

  target_include_directories(tts-ggml-core PRIVATE
      ${PROJECT_SOURCE_DIR}/addon/
      ${PROJECT_SOURCE_DIR}/addon/src/
      ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )
endif()

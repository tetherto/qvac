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
set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(bci-whispercpp CXX C)

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

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp")
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

add_bare_module(bci-whispercpp EXPORTS)

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

if(WIN32)
  target_link_libraries(
    ${bci-whispercpp}
    PRIVATE
      msvcrt.lib
  )
endif()

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
endif()

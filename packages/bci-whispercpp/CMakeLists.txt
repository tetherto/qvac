cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(bci-whispercpp CXX C)

qvac_addon_project_setup(VALGRIND_SUPP)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/ModelInterfaces.hpp")

# Fuzz-only configure (BUILD_FUZZING without BUILD_TESTING): build just the
# fuzz targets and skip engine find_package() + the .bare module so pure
# parse/transform drivers keep full ASan + LSan.
qvac_addon_fuzz_only_return()

qvac_addon_use_fabric()

qvac_addon_speech_engines(whisper)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

set(BCI_CORE_SOURCES
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/BCIConfig.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/BCIModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/EmbedderFit.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/NeuralProcessor.cpp
)

add_bare_module(bci-whispercpp EXPORTS)

target_sources(
  ${bci-whispercpp}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${BCI_CORE_SOURCES}
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

qvac_addon_link_fabric(${bci-whispercpp} ${qvac_fabric_target})
qvac_addon_finalize(${bci-whispercpp})

if(BUILD_TESTING)
  add_subdirectory(addon/tests)
endif()

qvac_addon_add_fuzz_subdirectory()

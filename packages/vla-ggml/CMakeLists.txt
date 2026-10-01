cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(qvac-lib-infer-vla LANGUAGES C CXX)

qvac_addon_project_setup()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/JsInterface.hpp" REQUIRED)

# Fuzz-only configure: safetensors_lite is header-only and needs no fabric.
if(BUILD_FUZZING AND NOT BUILD_TESTING)
  enable_testing()
  add_subdirectory(test/fuzz)
  return()
endif()

# ggml runtime is the shared @qvac/fabric prebuild (dynamically linked, loaded
# once per process); sets qvac_fabric_target + BACKENDS_SUBDIR_VALUE.
qvac_addon_use_fabric()

if(NOT BUILD_FUZZING)
add_bare_module(qvac-lib-infer-vla EXPORTS)

set(ADDON_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/smolvla.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/smolvla_adapter.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/pi05.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/groot.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/model_factory.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
)

target_sources(
  ${qvac-lib-infer-vla}
  PRIVATE
    ${ADDON_SOURCES}
)

target_include_directories(
  ${qvac-lib-infer-vla}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

qvac_addon_link_fabric(${qvac-lib-infer-vla} ${qvac_fabric_target})

qvac_addon_finalize(${qvac-lib-infer-vla} SUBDIR "${BACKENDS_SUBDIR_VALUE}")
endif()

if(BUILD_TESTING OR BUILD_FUZZING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
endif()

if(BUILD_TESTING)
  add_subdirectory(test/unit)
endif()

if(BUILD_FUZZING)
  add_subdirectory(test/fuzz)
endif()

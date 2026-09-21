cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(qvac-lib-infer-vla LANGUAGES C CXX)

qvac_addon_project_setup()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/JsInterface.hpp" REQUIRED)

# ggml runtime is the shared @qvac/fabric prebuild (dynamically linked, loaded
# once per process); sets qvac_fabric_target + BACKENDS_SUBDIR_VALUE.
qvac_addon_use_fabric()

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

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)
endif()

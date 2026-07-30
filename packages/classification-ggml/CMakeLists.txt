cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(classification-ggml LANGUAGES C CXX)

qvac_addon_project_setup()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/JsInterface.hpp" REQUIRED)
find_path(STB_INCLUDE_DIRS "stb_image.h" REQUIRED)

# ggml runtime is the shared @qvac/fabric prebuild (dynamically linked, loaded
# once per process); sets qvac_fabric_target + BACKENDS_SUBDIR_VALUE.
qvac_addon_use_fabric()

add_bare_module(classification-ggml EXPORTS)

set(ADDON_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ClassificationModel.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ImagePreprocessor.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MobileNetGraph.cpp
)

target_sources(
  ${classification-ggml}
  PRIVATE
    ${ADDON_SOURCES}
)

target_include_directories(
  ${classification-ggml}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${STB_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

qvac_addon_link_fabric(${classification-ggml} ${qvac_fabric_target})

qvac_addon_finalize(${classification-ggml} SUBDIR "${BACKENDS_SUBDIR_VALUE}")

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)
endif()

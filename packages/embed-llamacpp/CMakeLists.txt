cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(embed-llamacpp LANGUAGES C CXX)

qvac_addon_project_setup(VALGRIND_SUPP PRE_COMMIT_HOOK)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp")

# llama / ggml / vector-index runtime is the shared @qvac/fabric prebuild
# (dynamically linked, loaded once per process); sets qvac_fabric_target +
# BACKENDS_SUBDIR_VALUE.
qvac_addon_use_fabric()

add_bare_module(embed-llamacpp EXPORTS)

target_sources(
  ${embed-llamacpp}
  PRIVATE
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/vector-index-binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/utils.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/AsyncWeightsLoader.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/BackendSelection.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/logging.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ModelMetadata.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/BertModel.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/VectorIndex.cpp
)
target_include_directories(
  ${embed-llamacpp}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

qvac_addon_link_fabric(${embed-llamacpp} ${qvac_fabric_target})
qvac_addon_finalize(${embed-llamacpp} SUBDIR "${BACKENDS_SUBDIR_VALUE}")

if(BUILD_TESTING)
  enable_testing()
  add_subdirectory(test/unit)
endif()

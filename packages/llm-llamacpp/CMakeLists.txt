cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(inference-addon-llama LANGUAGES C CXX)

qvac_addon_project_setup()

find_path(PICOJSON_INCLUDE_DIRS "picojson/picojson.h")
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp")
# Required to call llama.cpp's `json_schema_to_grammar()` for per-request
# JSON-Schema → GBNF conversion. The function lives in libcommon inside the
# shared runtime but takes a `nlohmann::ordered_json`, so we need the full
# nlohmann headers, not just the forward decl shipped with
# `llama/common/json-schema-to-grammar.h`.
find_package(nlohmann_json CONFIG REQUIRED)
# Lock-free MPMC queue (moodycamel) backing the ContinuousBatchScheduler
# request intake: `processBatch` callers enqueue, the worker dequeues.
find_package(unofficial-concurrentqueue CONFIG REQUIRED)

# llama / ggml / mtmd / libcommon runtime is the shared @qvac/fabric prebuild
# (dynamically linked, loaded once per process); sets qvac_fabric_target +
# BACKENDS_SUBDIR_VALUE.
qvac_addon_use_fabric()

add_bare_module(inference-addon-llama EXPORTS)

set(ADDON_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/handlers/LlmParsers.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/handlers/GenerationParamHandlers.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/handlers/FinetuneParamHandlers.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/handlers/LoadConfigHandlers.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/AsyncWeightsLoader.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/CacheManager.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ContinuousBatchScheduler.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/GenerationParamsApply.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LoadFitNormalization.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuner.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuningHelpers.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MediaLoadOrder.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MultiRequestBatcher.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ReasoningBlockCompactor.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ModelMetadata.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/ChatTemplateUtils.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/ReasoningUtils.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/RecurrentStateSnapshot.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/ReasoningRollbackState.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/QwenTemplate.cpp
)

target_sources(
  ${inference-addon-llama}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${ADDON_SOURCES}
)
target_include_directories(
  ${inference-addon-llama}
  PRIVATE
    ${PICOJSON_INCLUDE_DIRS}
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)
target_link_libraries(
  ${inference-addon-llama}
  PRIVATE
    nlohmann_json::nlohmann_json
    unofficial::concurrentqueue::concurrentqueue
)

qvac_addon_link_fabric(${inference-addon-llama} ${qvac_fabric_target})
qvac_addon_finalize(${inference-addon-llama} SUBDIR "${BACKENDS_SUBDIR_VALUE}")

# Option to build CLI
option(BUILD_CLI "Build CLI tool example" FALSE)
if(BUILD_CLI)
  # Cache management integration test with automatic model download
  add_executable(cli_tool
    ${PROJECT_SOURCE_DIR}/addon/src/cli/cli_tool.cc
    ${PROJECT_SOURCE_DIR}/addon/src/handlers/LlmParsers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/handlers/LoadConfigHandlers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/AsyncWeightsLoader.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/CacheManager.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ContinuousBatchScheduler.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/GenerationParamsApply.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LoadFitNormalization.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuner.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuningHelpers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MediaLoadOrder.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MultiRequestBatcher.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ReasoningBlockCompactor.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ModelMetadata.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/ChatTemplateUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/ReasoningUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/RecurrentStateSnapshot.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/ReasoningRollbackState.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/QwenTemplate.cpp
  )

  target_include_directories(
    cli_tool
          PRIVATE
          ${PROJECT_SOURCE_DIR}/addon/src
          ${PICOJSON_INCLUDE_DIRS}
          ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  # Link required libraries
  target_link_libraries(
    cli_tool
          PRIVATE
          qvac-fabric::headers
          ${qvac_fabric_target}_module
          nlohmann_json::nlohmann_json
          unofficial::concurrentqueue::concurrentqueue
  )
  # Set C++20 standard for std::views support
  target_compile_features(cli_tool PRIVATE cxx_std_20)

  # A plain executable gets none of the runtime wiring add_bare_module() gives
  # the .bare module, so stage the shared runtime and its dlopen'd ggml backends
  # next to the binary and rpath them in.
  qvac_addon_stage_fabric_for_test(cli_tool ${qvac_fabric_target})
endif()

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()

  # Integration tests for model classes (includes backend selection tests)
  # Pass ENABLE_COVERAGE option to test subdirectory
  add_subdirectory(test/unit)
endif()

# Engine sources shared by the Bare addon and the browser (WebAssembly) build in
# web/. They must not use the Bare JS API: that stays in addon/src/js-interface,
# addon/src/addon and FinetuneParamHandlers.cpp.
set(LLM_ENGINE_SOURCES
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/handlers/LlmParsers.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/handlers/GenerationParamHandlers.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/handlers/LoadConfigHandlers.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/AsyncWeightsLoader.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/CacheCheckpointFile.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/CacheManager.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/ContinuousBatchScheduler.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/GenerationParamsApply.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/ImagePixelLimit.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/LlamaLazyInitializeBackend.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/LoadFitNormalization.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/LlamaModel.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/LlamaFinetuner.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/LlamaFinetuningHelpers.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/MediaLoadOrder.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/MtmdLlmContext.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/MultiRequestBatcher.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/SpeculativeRuntime.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/SpeculativeSequence.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/TextLlmContext.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/model-interface/ModelMetadata.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/utils/LoggingMacros.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/utils/BackendSelection.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/utils/ChatTemplateUtils.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/utils/ReasoningUtils.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/utils/SequenceStateSnapshot.cpp
  ${CMAKE_CURRENT_LIST_DIR}/../addon/src/utils/RequestRollbackState.cpp
)

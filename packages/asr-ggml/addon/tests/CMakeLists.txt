add_executable(asr_ggml_tests
  ${PROJECT_SOURCE_DIR}/addon/tests/test_shared_logging.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_main.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_app_memory_budget.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_core.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_main_gpu.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_whisper_lifecycle.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_whisper_segment_fields.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/AddonCppTest.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/parakeet_test_core.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/parakeet_test_config_and_audio.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/parakeet_test_fabric_options.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/ParakeetAddonCppTest.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/moss_transcribe_test.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/StreamingProcessor.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ParakeetStreamingProcessor.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper/WhisperConfig.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper/WhisperModel.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper/WhisperHandlers.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/parakeet/ParakeetModel.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/parakeet/ParakeetConfig.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/moss/MossTranscribeModel.cpp
)

target_include_directories(asr_ggml_tests PRIVATE
  ${PROJECT_SOURCE_DIR}/addon
  ${PROJECT_SOURCE_DIR}/addon/src
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/whisper
  ${PROJECT_SOURCE_DIR}/addon/tests
  ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
  ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(asr_ggml_tests PRIVATE
  GTest::gmock
  whisper::whisper
  qvac::parakeet
  qvac-fabric::headers
  ${qvac_fabric_target}_module
)

target_compile_definitions(asr_ggml_tests PRIVATE QVAC_ASR_GGML_TESTING)

qvac_addon_stage_fabric_for_test(asr_ggml_tests ${qvac_fabric_target})

if(ENABLE_COVERAGE)
  target_compile_options(asr_ggml_tests PRIVATE
    -fprofile-instr-generate
    -fcoverage-mapping
  )
  target_link_options(asr_ggml_tests PRIVATE
    -fprofile-instr-generate
  )
  message(STATUS "LLVM Coverage enabled for asr-ggml tests")
endif()

add_test(NAME asr_ggml_tests COMMAND asr_ggml_tests)

if(APPLE)
  add_executable(asr_metal_operator_probe metal_operator_probe.cpp)
  target_link_libraries(asr_metal_operator_probe PRIVATE
    qvac-fabric::headers
    ${qvac_fabric_target}_module
  )
  qvac_addon_stage_fabric_for_test(asr_metal_operator_probe ${qvac_fabric_target})
  add_test(NAME asr_metal_operator_probe COMMAND asr_metal_operator_probe)
endif()

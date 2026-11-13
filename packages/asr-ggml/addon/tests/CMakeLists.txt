# asr_ggml_tests is declared here, not in the package listfile, so the binary
# and the fabric runtime the helper stages next to it share one directory,
# build/addon/tests.
add_executable(asr_ggml_tests
  ${PROJECT_SOURCE_DIR}/addon/tests/test_main.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_app_memory_budget.cpp
  # whisper suite
  ${PROJECT_SOURCE_DIR}/addon/tests/test_core.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_main_gpu.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_whisper_lifecycle.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/test_whisper_segment_fields.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/AddonCppTest.cpp
  # parakeet suite
  ${PROJECT_SOURCE_DIR}/addon/tests/parakeet_test_core.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/parakeet_test_config_and_audio.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/parakeet_test_fabric_options.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/ParakeetAddonCppTest.cpp
  ${PROJECT_SOURCE_DIR}/addon/tests/moss_transcribe_test.cpp
  # engine cores recompiled for coverage instrumentation (tts-ggml pattern)
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

# The test links the shared fabric runtime like the module does; the helper
# stages the runtime and its backends next to the executable.
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

# CI invokes the test binary directly via npm scripts, so avoid running it
# during build-time discovery where libc++/coverage combinations have been
# aborting before the actual test step starts.
add_test(NAME asr_ggml_tests COMMAND asr_ggml_tests)

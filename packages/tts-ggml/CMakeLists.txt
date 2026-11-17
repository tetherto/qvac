cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(tts-ggml CXX C)

qvac_addon_project_setup(VALGRIND_SUPP PRE_COMMIT_HOOK)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/ModelInterfaces.hpp")

# Fuzz-only configure (BUILD_FUZZING without BUILD_TESTING): build just the
# fuzz targets and skip engine find_package() + the .bare module so pure
# parse/transform drivers keep full ASan + LSan.
qvac_addon_fuzz_only_return()

qvac_addon_use_fabric()

qvac_addon_speech_engines(tts)
find_package(mecab CONFIG REQUIRED)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_definitions(-D_DEBUG)
endif()

# The module is named after the platform package that ships it,
# qvac__tts-ggml-<suffix> (every iOS host shares `ios`), so that package is an
# ordinary addon: require.addon(), bare-pack and bare-link all find
# scripts/ci/slice-platform-packages.mjs.
bare_target(bare_target_value)
if(bare_target_value MATCHES "^ios-")
  set(module_name "qvac__tts-ggml-ios")
else()
  set(module_name "qvac__tts-ggml-${bare_target_value}")
endif()

add_bare_module(tts-ggml NAME ${module_name} EXPORTS)

target_sources(
  ${tts-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/JSAdapter.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/audio8/Audio8Model.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/chatterbox/ChatterboxModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/moss/MossModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/moss/MossSoundEffectModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/moss/MossSpeechModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/parler/ParlerModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/supertonic/SupertonicModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/cosyvoice/CosyvoiceModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/pocket/PocketModel.cpp
)

target_include_directories(
  ${tts-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon
    ${PROJECT_SOURCE_DIR}/addon/src
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_link_libraries(
  ${tts-ggml}
  PRIVATE
    tts-cpp::tts-cpp
    mecab::mecab
)

qvac_addon_link_fabric(${tts-ggml} ${qvac_fabric_target})
qvac_addon_finalize(${tts-ggml})

if(WIN32)
  # mecab.lib and bare_delay_load.lib both export DllMain. mecab's
  # libmecab.cpp defines a stub that returns TRUE; bare_delay_load defines
  # the real entry point used to dispatch the /DELAYLOAD:bare.exe imports
  # the module relies on. bare_delay_load.lib is listed before mecab.lib in
  # the link line, so /FORCE:MULTIPLE makes the linker pick the
  # bare_delay_load DllMain and discard the mecab stub. Mirrors
  # packages/tts-onnx/CMakeLists.txt.
  target_link_options(
    ${tts-ggml}_module
    PRIVATE
      /FORCE:MULTIPLE
  )
endif()

if(BUILD_TESTING)
  enable_testing()
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)

  add_executable(
    tts_ggml_tests
      addon/tests/backend_env.cpp
      addon/tests/test_app_memory_budget.cpp
      addon/tests/test_audio8_config.cpp
      addon/tests/test_backend_utils.cpp
      addon/tests/test_fabric_options.cpp
      addon/tests/test_chatterbox_config.cpp
      addon/tests/test_moss_config.cpp
      addon/tests/test_moss_sound_effect_config.cpp
      addon/tests/test_moss_speech_config.cpp
      addon/tests/test_parler_config.cpp
      addon/tests/test_supertonic_config.cpp
      addon/tests/test_cosyvoice_config.cpp
      addon/tests/test_time_stretch.cpp
      addon/tests/test_streaming_enhancer.cpp
      addon/tests/test_output_resampler.cpp
      addon/tests/test_pcm_conversion.cpp
      addon/tests/test_log_forwarding.cpp
      addon/tests/test_number_conversion.cpp
      addon/tests/test_runtime_stats.cpp
      addon/tests/test_voice_controls_query.cpp
      addon/tests/AddonCppTest.cpp
      addon/src/model-interface/audio8/Audio8Model.cpp
      addon/src/model-interface/chatterbox/ChatterboxModel.cpp
      addon/src/model-interface/moss/MossModel.cpp
      addon/src/model-interface/moss/MossSoundEffectModel.cpp
      addon/src/model-interface/moss/MossSpeechModel.cpp
      addon/src/model-interface/parler/ParlerModel.cpp
      addon/src/model-interface/supertonic/SupertonicModel.cpp
      addon/src/model-interface/cosyvoice/CosyvoiceModel.cpp
  )

  target_include_directories(tts_ggml_tests
    PRIVATE
      ${PROJECT_SOURCE_DIR}/addon
      ${PROJECT_SOURCE_DIR}/addon/src
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  target_link_libraries(tts_ggml_tests
    PRIVATE
      GTest::gmock_main
      tts-cpp::tts-cpp
      qvac-fabric::headers
      ${qvac_fabric_target}_module
  )
  qvac_addon_stage_fabric_for_test(tts_ggml_tests ${qvac_fabric_target})

  if(ENABLE_COVERAGE)
    # LLVM source-based coverage (clang).  Same flag set parakeet uses.
    target_compile_options(tts_ggml_tests PRIVATE
      -fprofile-instr-generate
      -fcoverage-mapping
    )
    target_link_options(tts_ggml_tests PRIVATE
      -fprofile-instr-generate
    )
    message(STATUS "LLVM Coverage enabled for tts-ggml tests")
  endif()

  # CI invokes the test binary directly via npm scripts (so it can pass
  # gtest_output= and capture results.xml); avoid running the binary
  # during configure-time discovery to keep configure cheap.
  add_test(NAME tts_ggml_tests COMMAND tts_ggml_tests)
endif()

qvac_addon_add_fuzz_subdirectory()

add_executable(qvac-lib-inference-tts-unit-test)

# collect all sources from src and mocks directories
file(GLOB_RECURSE TEST_SOURCES "${CMAKE_SOURCE_DIR}/addon/test/unit/src/*")
file(GLOB_RECURSE TEST_MOCKS "${CMAKE_SOURCE_DIR}/addon/test/unit/mocks/*")

target_sources(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/TTSModel.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/ChatterboxEngine.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/SupertonicEngine.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/OnnxInferSession.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/Fp16Utils.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/TensorFloatHandler.cpp
    ${TEST_SOURCES}
    ${TEST_MOCKS}
)

find_package(tokenizers_cpp CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

if(TARGET onnxruntime::onnxruntime_static)
  set(QVAC_TTS_UNITTEST_ONNXRUNTIME onnxruntime::onnxruntime_static)
else()
  set(QVAC_TTS_UNITTEST_ONNXRUNTIME onnxruntime::onnxruntime)
endif()

target_include_directories(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon
    ${CMAKE_SOURCE_DIR}/addon/test/unit/
)

target_link_libraries(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    ${QVAC_TTS_UNITTEST_ONNXRUNTIME}
    tokenizers::tokenizers_cpp
    nlohmann_json::nlohmann_json
    ${QVAC_UTF8PROC_TARGET}
    GTest::gtest
    GTest::gtest_main
    GTest::gmock
    GTest::gmock_main
)

gtest_discover_tests(
  qvac-lib-inference-tts-unit-test
  DISCOVERY_MODE PRE_TEST
)

if(WIN32)
  target_link_libraries(
    qvac-lib-inference-tts-unit-test
    PRIVATE
      msvcrt.lib
  )
endif()

if(ENABLE_COVERAGE)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    message("Enabling coverage instrumentation")

    target_compile_options(qvac-lib-inference-tts-unit-test PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_link_options(qvac-lib-inference-tts-unit-test PRIVATE -fprofile-instr-generate)

  else()
    message(WARNING "ENABLE_COVERAGE is not supported.")
  endif()
endif()


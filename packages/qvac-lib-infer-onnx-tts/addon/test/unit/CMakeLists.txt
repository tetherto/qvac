find_package(GTest REQUIRED)

add_executable(qvac-lib-inference-tts-unit-test)

# collect all sources from src and mocks directories
file(GLOB_RECURSE TEST_SOURCES "${CMAKE_SOURCE_DIR}/addon/test/unit/src/*")
file(GLOB_RECURSE TEST_MOCKS "${CMAKE_SOURCE_DIR}/addon/test/unit/mocks/*")

target_sources(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/TTSModel.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/ChatterboxEngine.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/ChatterboxTextPreprocessor.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/SupertonicEngine.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/OnnxInferSession.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/Fp16Utils.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/TensorFloatHandler.cpp
    ${TEST_SOURCES}
    ${TEST_MOCKS}
)

target_include_directories(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon
    ${CMAKE_SOURCE_DIR}/addon/test/unit/
)

find_package(tokenizers_cpp CONFIG REQUIRED)
find_package(unofficial-utf8proc CONFIG REQUIRED)
if(TARGET utf8proc::utf8proc)
  set(QVAC_UTF8PROC_TARGET utf8proc::utf8proc)
elseif(TARGET utf8proc)
  set(QVAC_UTF8PROC_TARGET utf8proc)
else()
  message(FATAL_ERROR "utf8proc CMake target missing (expected from unofficial-utf8proc)")
endif()

if(TARGET qvac-onnx::qvac-onnx-static)
  set(QVAC_TTS_TEST_ORT_TARGET qvac-onnx::qvac-onnx-static)
elseif(DEFINED qvac_onnx_target)
  set(QVAC_TTS_TEST_ORT_TARGET ${qvac_onnx_target}_module)
else()
  set(QVAC_TTS_TEST_ORT_TARGET qvac-onnx::headers)
endif()

target_link_libraries(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    qvac-onnx::headers
    ${QVAC_TTS_TEST_ORT_TARGET}
    tokenizers::tokenizers_cpp
    ${QVAC_UTF8PROC_TARGET}
    GTest::gtest
    GTest::gtest_main
    GTest::gmock
    GTest::gmock_main
)

if(WIN32)
  target_link_libraries(
    qvac-lib-inference-tts-unit-test
    PRIVATE
      msvcrt.lib
  )
endif()

bare_platform(_TTS_TEST_PLATFORM)
bare_arch(_TTS_TEST_ARCH)
set(_tts_onnx_prebuilds "${CMAKE_SOURCE_DIR}/node_modules/@qvac/onnx/prebuilds/${_TTS_TEST_PLATFORM}-${_TTS_TEST_ARCH}")
if(EXISTS "${_tts_onnx_prebuilds}/qvac__onnx.bare" AND NOT EXISTS "${_tts_onnx_prebuilds}/qvac__onnx@0.bare")
  file(CREATE_LINK "${_tts_onnx_prebuilds}/qvac__onnx.bare" "${_tts_onnx_prebuilds}/qvac__onnx@0.bare" COPY_ON_ERROR)
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
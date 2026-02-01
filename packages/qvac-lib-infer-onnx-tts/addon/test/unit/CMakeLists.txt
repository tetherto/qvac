find_package(GTest REQUIRED)

add_executable(qvac-lib-inference-tts-unit-test)

# collect all sources from src and mocks directories
file(GLOB_RECURSE TEST_SOURCES "${CMAKE_SOURCE_DIR}/addon/test/unit/src/*")
file(GLOB_RECURSE TEST_MOCKS "${CMAKE_SOURCE_DIR}/addon/test/unit/mocks/*")

target_sources(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/PiperEngine.cpp
    ${CMAKE_SOURCE_DIR}/addon/src/model-interface/TTSModel.cpp
    ${TEST_SOURCES}
    ${TEST_MOCKS}
)

target_include_directories(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon
    ${CMAKE_SOURCE_DIR}/addon/test/unit/
)

target_link_libraries(
  qvac-lib-inference-tts-unit-test
  PRIVATE
    piper_core
    onnxruntime::onnxruntime_static
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

if(ENABLE_COVERAGE)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    message("Enabling coverage instrumentation")

    target_compile_options(qvac-lib-inference-tts-unit-test PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_link_options(qvac-lib-inference-tts-unit-test PRIVATE -fprofile-instr-generate)

  else()
    message(WARNING "ENABLE_COVERAGE is not supported.")
  endif()
endif()
cmake_minimum_required(VERSION 3.25)

project(nmt_tests LANGUAGES C CXX)

find_package(GTest CONFIG REQUIRED)

option(ENABLE_COVERAGE "Enable coverage instrumentation for unit tests" OFF)

set(TEST_SOURCES
  translation_tests.cpp
  nmt_model_wrapper_test_indic.cpp
  nmt_test.cpp
  test_nmt_lazy_init_backend.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/TranslationModel.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_tokenization.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_state_backend.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_loader.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_graph_decoder.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_graph_encoder.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_beam_search.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/nmt_utils.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/NmtLazyInitializeBackend.cpp
)

# Add Bergamot validation tests if Bergamot is enabled
if(USE_BERGAMOT)
   list(APPEND TEST_SOURCES
     bergamot_validation_tests.cpp
     batch_bergamot_validation_tests.cpp
     ${CMAKE_SOURCE_DIR}/addon/src/model-interface/bergamot.cpp
   )
endif()

add_executable(addon-test ${TEST_SOURCES})

target_compile_options(
  addon-test
  PRIVATE
    -Wno-deprecated
    -Wfatal-errors
    -g)

# Disable POSIX regex in gtest - clang cross-compilation target doesn't find regex.h properly
target_compile_definitions(addon-test PRIVATE GTEST_HAS_POSIX_RE=0)

if(NOT WIN32)
  target_compile_options(
    addon-test
    PRIVATE
      -fno-omit-frame-pointer
  )
endif()

target_include_directories(
  addon-test
  PRIVATE
  ${CMAKE_SOURCE_DIR}/addon/src
  ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

# Add bergamot compile definition if enabled
if(USE_BERGAMOT)
  find_package(bergamot-translator CONFIG REQUIRED)
  target_compile_definitions(addon-test PRIVATE HAVE_BERGAMOT)
endif()

# Optional coverage instrumentation
if(ENABLE_COVERAGE)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    MESSAGE(STATUS ENABLING_PROFILING)

    target_compile_options(addon-test PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_link_options(addon-test PRIVATE -fprofile-instr-generate)
  elseif(MSVC)
    message(WARNING "ENABLE_COVERAGE is not supported on MSVC in this script.")
  endif()
endif()

if(DEFINED SENTENCEPIECE_INCLUDE_DIRS)
  target_include_directories(
    addon-test
    PRIVATE
      ${SENTENCEPIECE_INCLUDE_DIRS}
  )
endif()

target_link_libraries(
  addon-test
  PRIVATE
    ${SENTENCEPIECE_TARGET}
    ggml::ggml
    protobuf::libprotobuf
    GTest::gtest
    GTest::gtest_main
)

# Link bergamot library if enabled
if(USE_BERGAMOT)
  target_link_libraries(
    addon-test
    PRIVATE
      bergamot-translator::bergamot-translator
  )
endif()

if(NOT WIN32)
  target_link_libraries(
    addon-test
    PRIVATE
      -fsanitize=address
  )
endif()

if(absl_FOUND)
  target_link_libraries(
    addon-test
    PRIVATE
      absl::flags
      absl::flags_internal
  )
endif()

if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
  target_link_libraries(addon-test PRIVATE Iconv::Iconv)
endif()

if(WIN32)
  target_link_libraries(
    addon-test
    PRIVATE
      msvcrt.lib
  )
endif()

add_test(NAME TranslationModelTests COMMAND addon-test)
set_tests_properties(TranslationModelTests PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 900)  # 15 minutes

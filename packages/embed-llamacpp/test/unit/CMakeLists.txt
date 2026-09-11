find_package(GTest CONFIG REQUIRED)

if(NOT DEFINED ENABLE_COVERAGE)
  set(ENABLE_COVERAGE OFF)
endif()

add_executable(
  addon-test
  test_addon_cpp.cpp
  test_async_weights_loader.cpp
  test_backend_selection.cpp
  test_cancel_stale_flag.cpp
  test_bert_model.cpp
  test_llama_lazy_init_backend.cpp
  test_logging.cpp
  test_model_metadata.cpp
  test_utils.cpp
  backend_env.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/AsyncWeightsLoader.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/BackendSelection.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/BertModel.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/ModelMetadata.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/logging.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/utils.cpp
)

target_compile_options(
  addon-test
  PRIVATE
    -Wno-deprecated
    -Wfatal-errors
    -g)

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

target_compile_features(addon-test PRIVATE cxx_std_20)

if(APPLE AND NOT IOS)
  set_target_properties(addon-test PROPERTIES
    XCODE_ATTRIBUTE_MACOSX_DEPLOYMENT_TARGET "14.0"
    OSX_DEPLOYMENT_TARGET "14.0"
  )
endif()

get_filename_component(TEST_BINARY_DIR "${CMAKE_CURRENT_BINARY_DIR}" ABSOLUTE)
target_compile_definitions(addon-test PRIVATE 
  TEST_BINARY_DIR="${TEST_BINARY_DIR}"
)

if(ENABLE_COVERAGE)
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    MESSAGE(STATUS "ENABLING_PROFILING")

    target_compile_options(addon-test PRIVATE -fprofile-instr-generate -fcoverage-mapping)
    target_link_options(addon-test PRIVATE -fprofile-instr-generate)
  elseif(MSVC)
    message(WARNING "ENABLE_COVERAGE is not supported on MSVC in this script.")
  endif()
endif()

target_link_libraries(
  addon-test
  PRIVATE
    qvac-fabric::headers
    ${qvac_fabric_target}_module
    GTest::gtest
    GTest::gtest_main
    GTest::gmock_main
)

# Stage the shared Fabric runtime and its dlopen'd ggml backends beside the test
# binary. backend_env.cpp uses GGML_BACKEND_DIR to preload them.
qvac_addon_stage_fabric_for_test(addon-test ${qvac_fabric_target})

# AddressSanitizer on the test executable, kept in a deliberately LIMITED form.
# addon-test dynamically links the shared @qvac/fabric runtime
# (qvac__fabric@0.bare), and the shipped fabric prebuild is built with
# -static-libstdc++. See packages/classification-ggml/test/unit/CMakeLists.txt
# for the full rationale. scripts/run-cpp-tests.js sets ASAN_OPTIONS for local/CI
# runs: alloc_dealloc_mismatch=0:detect_leaks=0:abort_on_error=1.
if(NOT WIN32)
  target_link_libraries(
    addon-test
    PRIVATE
      -fsanitize=address
  )
endif()

add_test(NAME EmbedModelTests COMMAND addon-test)
set_tests_properties(EmbedModelTests PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 900)


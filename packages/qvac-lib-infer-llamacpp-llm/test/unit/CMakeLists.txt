# This file is included as a subdirectory from the main CMakeLists.txt
# GTest is already found in the parent, but we can find it here too for clarity
find_package(GTest CONFIG REQUIRED)

# ENABLE_COVERAGE option should be set in parent CMakeLists.txt
# If not set, default to OFF
if(NOT DEFINED ENABLE_COVERAGE)
  set(ENABLE_COVERAGE OFF)
endif()

add_executable(
  addon-test
  test_llama_model.cpp
  test_cache_management.cpp
  test_text_llm_context.cpp
  test_addon_cpp.cpp
  test_backend_selection.cpp
  # Placeholder tests (to be implemented)
  test_mtmd_llm_context.cpp
  test_llm_context_base.cpp
  # Utility tests
  test_utf8_token_buffer.cpp
  test_chat_template_utils.cpp
  test_qwen3_reasoning_utils.cpp
  test_qwen_template.cpp
  test_logging_macros.cpp
  test_llama_lazy_init_backend.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/CacheManager.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/ChatTemplateUtils.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/Qwen3ReasoningUtils.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/QwenTemplate.cpp
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
  ${PICOJSON_INCLUDE_DIRS}
  ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

# Set C++20 standard for std::views support (required by qvac-lib-inference-addon-cpp)
target_compile_features(addon-test PRIVATE cxx_std_20)

# Set macOS deployment target for C++20 std::format support
if(APPLE AND NOT IOS)
  set_target_properties(addon-test PROPERTIES
    XCODE_ATTRIBUTE_MACOSX_DEPLOYMENT_TARGET "14.0"
    OSX_DEPLOYMENT_TARGET "14.0"
  )
endif()

# Define test binary directory path for runtime use
get_filename_component(TEST_BINARY_DIR "${CMAKE_CURRENT_BINARY_DIR}" ABSOLUTE)
target_compile_definitions(addon-test PRIVATE 
  TEST_BINARY_DIR="${TEST_BINARY_DIR}"
)

# Optional coverage instrumentation
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
    llama::llama
    llama::common
    llama::mtmd
    GTest::gtest
    GTest::gtest_main
    GTest::gmock_main
)

if(NOT WIN32)
  target_link_libraries(
    addon-test
    PRIVATE
      -fsanitize=address
  )
endif()

if(WIN32)
  target_link_libraries(
    addon-test
    PRIVATE
      msvcrt.lib
  )
endif()

# Copy ggml backend libraries next to the test executable
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    add_custom_command(TARGET addon-test POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:ggml::${_backend}>
        ${CMAKE_CURRENT_BINARY_DIR}
      COMMENT "Copying ggml backend ${_backend} to test directory"
    )
  endforeach()
endif()

add_test(NAME LlamaModelTests COMMAND addon-test)
set_tests_properties(LlamaModelTests PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 900)  # 15 minutes


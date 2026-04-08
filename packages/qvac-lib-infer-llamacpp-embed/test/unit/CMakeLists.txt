find_package(GTest CONFIG REQUIRED)

if(NOT DEFINED ENABLE_COVERAGE)
  set(ENABLE_COVERAGE OFF)
endif()

add_executable(
  addon-test
  test_addon_cpp.cpp
  test_backend_selection.cpp
  test_cancel_stale_flag.cpp
  test_bert_model.cpp
  test_llama_lazy_init_backend.cpp
  test_logging.cpp
  test_utils.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/BackendSelection.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/BertModel.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
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
  BEFORE PRIVATE
    ${CMAKE_SOURCE_DIR}/addon/src/patches
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
    llama::llama
    llama::common
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

add_test(NAME EmbedModelTests COMMAND addon-test)
set_tests_properties(EmbedModelTests PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 900)


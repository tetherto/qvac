find_package(GTest REQUIRED)

add_library(bci-core STATIC ${BCI_CORE_SOURCES})

target_link_libraries(bci-core PRIVATE
    whisper::whisper
    qvac-fabric::headers
)

target_include_directories(bci-core PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/
    ${PROJECT_SOURCE_DIR}/addon/src/
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

add_executable(
    test-bci-core
    test_bci_fit.cpp
    test_core.cpp
    test_embedder_fit.cpp
    test_main_gpu.cpp
)

target_compile_definitions(test-bci-core PRIVATE
    BCI_TEST_FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/fixtures"
)

target_include_directories(test-bci-core PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/
    ${PROJECT_SOURCE_DIR}/addon/src/
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/bci/
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

# The test links the shared fabric runtime like the module does; the helper
# stages the runtime and its backends next to the executable.
target_link_libraries(test-bci-core PRIVATE
    bci-core
    whisper::whisper
    qvac-fabric::headers
    ${qvac_fabric_target}_module
    GTest::gtest_main
    GTest::gmock
)
qvac_addon_stage_fabric_for_test(test-bci-core ${qvac_fabric_target})

# Exercise the real model load/reload path against deterministic backend
# boundaries, without requiring GPU hardware or the large BCI model assets.
# GNU ld/lld --wrap is available on the Linux native-test runners.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_sources(test-bci-core PRIVATE test_model_load.cpp)
  foreach(_symbol IN ITEMS
      ggml_backend_dev_count ggml_backend_dev_get ggml_backend_dev_type
      ggml_backend_dev_backend_reg ggml_backend_reg_name
      ggml_backend_dev_name ggml_backend_dev_description ggml_backend_dev_memory
      ggml_backend_load_all_from_path qvac_fabric_load_backends
      whisper_init_from_file_with_params whisper_free whisper_full)
    target_link_options(test-bci-core PRIVATE "LINKER:--wrap=${_symbol}")
  endforeach()
endif()

if(ENABLE_COVERAGE)
    target_compile_options(test-bci-core PRIVATE
        -fprofile-instr-generate
        -fcoverage-mapping
    )
    target_compile_options(bci-core PRIVATE
        -fprofile-instr-generate
        -fcoverage-mapping
    )
    target_link_options(test-bci-core PRIVATE
        -fprofile-instr-generate
    )
    message(STATUS "LLVM Coverage enabled for bci-core tests")
endif()

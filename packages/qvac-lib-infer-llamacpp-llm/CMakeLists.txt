cmake_minimum_required(VERSION 3.25)

option(ANDROID_STL "Android STL linkage" c++_shared)
option(BUILD_TESTING "Build tests" OFF)
option(ENABLE_COVERAGE "Enable coverage instrumentation for unit tests" OFF)
if(BUILD_TESTING)
  list(APPEND VCPKG_MANIFEST_FEATURES "tests")
endif()

option(VK_PROFILING "Force vk performance logging in qvac-fabric" OFF)
if(VK_PROFILING)
  list(APPEND VCPKG_MANIFEST_FEATURES "vk-profiling")
endif()

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

project(qvac-lib-inference-addon-llama C CXX)

find_path(VCPKG_INSTALLED_PATH share/qvac-lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/qvac-lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)

find_path(PICOJSON_INCLUDE_DIRS "picojson/picojson.h")
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/JsInterface.hpp")
find_package(llama CONFIG REQUIRED)

if(WIN32)
  add_definitions( -DNOMINMAX -DWIN32_MEAN_AND_LEAN -DNOGDI )
endif()

add_bare_module(qvac-lib-inference-addon-llama EXPORTS)
  set(ADDON_SOURCES
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  )

  list(APPEND ADDON_SOURCES
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/CacheManager.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuningHelpers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
  )

  target_sources(
    ${qvac-lib-inference-addon-llama}
    PRIVATE
      ${ADDON_SOURCES}
  )
  target_include_directories(
    ${qvac-lib-inference-addon-llama}
    PRIVATE
      ${PICOJSON_INCLUDE_DIRS}
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
      ${PROJECT_SOURCE_DIR}/addon/src
  )
  target_link_libraries(
    ${qvac-lib-inference-addon-llama}
    PRIVATE
      llama::llama
      llama::common
      llama::mtmd
  )

target_compile_definitions(${qvac-lib-inference-addon-llama} PUBLIC JS_LOGGER)

# Option to build CLI
option(BUILD_CLI "Build CLI tool example" FALSE)
if(BUILD_CLI)
  # Cache management integration test with automatic model download
  add_executable(cli_tool
    ${PROJECT_SOURCE_DIR}/addon/src/cli/cli_tool.cc
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
  )

  target_include_directories(
    cli_tool
          PRIVATE
          ${PROJECT_SOURCE_DIR}/addon/src
          ${PICOJSON_INCLUDE_DIRS}
          ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  # Link required libraries
  target_link_libraries(
    cli_tool
          PRIVATE
          llama::llama
          llama::common
          llama::mtmd
  )

  find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/JsInterface.hpp")
  target_include_directories(cli_tool PRIVATE ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS})
  # Set C++20 standard for std::views support
  target_compile_features(cli_tool PRIVATE cxx_std_20)
  endif()

# Option to build tests
option(BUILD_TESTS "Build cache state machine tests" FALSE)
if(BUILD_TESTS)
  # Cache management integration test with automatic model download
  add_executable(test_cache_management_integration
    ${PROJECT_SOURCE_DIR}/test/integration/test_cache_management.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
  )

  target_include_directories(
          test_cache_management_integration
          PRIVATE
          ${PROJECT_SOURCE_DIR}/addon/src
          ${PICOJSON_INCLUDE_DIRS}
          ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  # Define macro to exclude Bare runtime dependencies in standalone tests
  target_compile_definitions(test_cache_management_integration PRIVATE STANDALONE_TEST_BUILD=1)

  # Link required libraries
  target_link_libraries(
          test_cache_management_integration
          PRIVATE
          llama::llama
          llama::common
          llama::mtmd
  )

  # Set C++20 standard for std::views support
  target_compile_features(test_cache_management_integration PRIVATE cxx_std_20)

  # Finetuning integration test
  add_executable(test_llama_model_finetuning
    ${PROJECT_SOURCE_DIR}/test/integration/test_llama_model_finetuning.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuningHelpers.cpp
  )

  target_include_directories(
    test_llama_model_finetuning
    PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src
    ${PICOJSON_INCLUDE_DIRS}
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
  )

  # Define macro to exclude Bare runtime dependencies in standalone tests
  target_compile_definitions(test_llama_model_finetuning PRIVATE STANDALONE_TEST_BUILD=1)

  target_link_libraries(
    test_llama_model_finetuning
    PRIVATE
    llama::llama
    llama::common
  )

  target_compile_features(test_llama_model_finetuning PRIVATE cxx_std_20)
endif()

if(ANDROID)
  find_package(Vulkan REQUIRED)
  target_link_libraries(${qvac-lib-inference-addon-llama} PRIVATE ${Vulkan_LIBRARY})
endif()

if(WIN32)
  target_link_libraries(
    ${qvac-lib-inference-addon-llama}
    PRIVATE
      msvcrt.lib
  )
endif()

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

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(inference-addon-llama C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)

find_path(PICOJSON_INCLUDE_DIRS "picojson/picojson.h")
find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp")
# llama-targets.cmake transitively requires OpenSSL::SSL via cpp-httplib's
# IMPORTED interface. Make OpenSSL discoverable before find_package(llama)
# so the target chain resolves on local builds.
find_package(OpenSSL)
find_package(llama CONFIG REQUIRED)
# Required to call llama.cpp's `json_schema_to_grammar()` for per-request
# JSON-Schema → GBNF conversion. The function signature lives in libcommon
# (linked via `llama::common`) but takes a `nlohmann::ordered_json`, so we
# need the full nlohmann headers, not just the forward decl shipped with
# `llama/common/json-schema-to-grammar.h`.
find_package(nlohmann_json CONFIG REQUIRED)

if(WIN32)
  add_definitions( -DNOMINMAX -DWIN32_MEAN_AND_LEAN -DNOGDI )
endif()
# After find_package(llama) around line 39, add:
if(ANDROID)
  set(DEBUG_LOG "${CMAKE_BINARY_DIR}/openmp_search_debug.txt")
  file(WRITE ${DEBUG_LOG} "=== OpenMP Search Debug ===\n\n")
  file(APPEND ${DEBUG_LOG} "Timestamp: ${CMAKE_CURRENT_DATE}\n")
  file(APPEND ${DEBUG_LOG} "HOST: ${CMAKE_HOST_SYSTEM_NAME}\n")
  file(APPEND ${DEBUG_LOG} "NDK: $ENV{ANDROID_NDK}\n")
  file(APPEND ${DEBUG_LOG} "CMAKE_ANDROID_NDK: ${CMAKE_ANDROID_NDK}\n")
  file(APPEND ${DEBUG_LOG} "ANDROID_ABI: ${ANDROID_ABI}\n\n")
  
  # Determine host platform
  if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Windows")
    set(NDK_HOST "windows-x86_64")
  elseif(CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux")
    set(NDK_HOST "linux-x86_64")
  else()
    set(NDK_HOST "darwin-x86_64")
  endif()
  file(APPEND ${DEBUG_LOG} "NDK_HOST: ${NDK_HOST}\n\n")
  
  # Single path for NDK 29 with Clang 21 (aarch64 only)
  set(LIBOMP_PATHS
    "$ENV{ANDROID_NDK}/toolchains/llvm/prebuilt/${NDK_HOST}/lib/clang/21/lib/linux/aarch64/libomp.so"
  )
  
  file(APPEND ${DEBUG_LOG} "Checking paths:\n")
  set(LIBOMP_FOUND_PATH "")
  foreach(path ${LIBOMP_PATHS})
    file(TO_CMAKE_PATH "${path}" path_normalized)
    if(EXISTS ${path_normalized})
      set(LIBOMP_FOUND_PATH ${path_normalized})
      file(APPEND ${DEBUG_LOG} "  [FOUND] ${path_normalized}\n")
      break()
    else()
      file(APPEND ${DEBUG_LOG} "  [NOT FOUND] ${path_normalized}\n")
    endif()
  endforeach()
  
  # Try glob search if not found
  if(NOT LIBOMP_FOUND_PATH)
    file(APPEND ${DEBUG_LOG} "\nTrying glob search in NDK...\n")
    file(GLOB_RECURSE LIBOMP_SEARCH 
      "$ENV{ANDROID_NDK}/toolchains/llvm/prebuilt/${NDK_HOST}/lib*/**/libomp.so"
    )
    if(LIBOMP_SEARCH)
      list(GET LIBOMP_SEARCH 0 LIBOMP_FOUND_PATH)
      file(APPEND ${DEBUG_LOG} "  [FOUND via glob] ${LIBOMP_FOUND_PATH}\n")
      foreach(found_path ${LIBOMP_SEARCH})
        file(APPEND ${DEBUG_LOG} "    - ${found_path}\n")
      endforeach()
    else()
      file(APPEND ${DEBUG_LOG} "  [GLOB FOUND NOTHING]\n")
    endif()
  endif()
  
  # Result
  file(APPEND ${DEBUG_LOG} "\n=== RESULT ===\n")
  if(LIBOMP_FOUND_PATH)
    file(APPEND ${DEBUG_LOG} "LIBOMP_FOUND_PATH: ${LIBOMP_FOUND_PATH}\n")
    file(APPEND ${DEBUG_LOG} "Status: SUCCESS - Will install libomp.so\n")
  else()
    file(APPEND ${DEBUG_LOG} "LIBOMP_FOUND_PATH: (empty)\n")
    file(APPEND ${DEBUG_LOG} "Status: FAILED - libomp.so not found!\n")
  endif()
  
  file(APPEND ${DEBUG_LOG} "\n=== End Debug ===\n")

endif()
bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message("Building inference-addon-llama with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

# Install dynamic libs to prebuild folder
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
  endforeach()
endif()

add_bare_module(inference-addon-llama EXPORTS ${BACKEND_DL_LIBS})

if(ANDROID AND LIBOMP_FOUND_PATH)
  message(STATUS "Installing libomp.so from: ${LIBOMP_FOUND_PATH}")
  
  # Install to prebuilds (this works immediately)
  install(FILES ${LIBOMP_FOUND_PATH} 
  DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/prebuilds/android-arm64/qvac__llm-llamacpp
  RENAME libomp.so
  )
  
  # install(FILES ${DEBUG_LOG} 
  # DESTINATION ${CMAKE_CURRENT_SOURCE_DIR}/prebuilds/android-arm64/qvac__llm-llamacpp
  # RENAME openmp_debug_log.txt
  # )
  
  # Link to main target
  target_link_libraries(${inference-addon-llama} PRIVATE ${LIBOMP_FOUND_PATH})
  target_compile_options(${inference-addon-llama} PRIVATE -fopenmp)
  
  # Copy to build dir after build (target now exists!)
  add_custom_command(TARGET ${inference-addon-llama}_module POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      ${LIBOMP_FOUND_PATH}
      $<TARGET_FILE_DIR:${inference-addon-llama}_module>/libomp.so
    COMMENT "Copying libomp.so to build directory"
  )
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${inference-addon-llama}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

  set(ADDON_SOURCES
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  )

  list(APPEND ADDON_SOURCES
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/AsyncWeightsLoader.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/CacheManager.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ContextSlider.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/GenerationParamsApply.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuner.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuningHelpers.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ToolsCompactController.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ModelMetadata.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/ChatTemplateUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/Qwen3ReasoningUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/Qwen3ToolsDynamicTemplate.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/QwenTemplate.cpp
  )

  target_sources(
    ${inference-addon-llama}
    PRIVATE
      ${ADDON_SOURCES}
  )
  target_include_directories(
    ${inference-addon-llama}
    PRIVATE
      ${PICOJSON_INCLUDE_DIRS}
      ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
      ${PROJECT_SOURCE_DIR}/addon/src
  )
  target_link_libraries(
    ${inference-addon-llama}
    PRIVATE
      llama::llama
      llama::common
      llama::mtmd
      nlohmann_json::nlohmann_json
  )


target_compile_definitions(${inference-addon-llama} PUBLIC JS_LOGGER)
target_compile_definitions(${inference-addon-llama} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

# Option to build CLI
option(BUILD_CLI "Build CLI tool example" FALSE)
if(BUILD_CLI)
  # Cache management integration test with automatic model download
  add_executable(cli_tool
    ${PROJECT_SOURCE_DIR}/addon/src/cli/cli_tool.cc
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/AsyncWeightsLoader.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/CacheManager.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ContextSlider.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/GenerationParamsApply.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaFinetuner.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ToolsCompactController.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/ModelMetadata.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/ChatTemplateUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/Qwen3ReasoningUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/Qwen3ToolsDynamicTemplate.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/QwenTemplate.cpp
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
          nlohmann_json::nlohmann_json
  )
  find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp")
  target_include_directories(cli_tool PRIVATE ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS})
  # Set C++20 standard for std::views support
  target_compile_features(cli_tool PRIVATE cxx_std_20)
  
  # Install ggml backends next to the CLI tool binary in build folder
  if((ANDROID OR UNIX) AND NOT APPLE)
    foreach(_backend ${GGML_AVAILABLE_BACKENDS})
      add_custom_command(TARGET cli_tool POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
          $<TARGET_FILE:ggml::${_backend}>
          ${CMAKE_CURRENT_BINARY_DIR}
        COMMENT "Copying ggml backend ${_backend} to build directory"
      )
    endforeach()
  endif()
  endif()

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  
  # Integration tests for model classes (includes backend selection tests)
  # Pass ENABLE_COVERAGE option to test subdirectory
  add_subdirectory(test/unit)
endif()

if(WIN32)
  target_link_libraries(
    ${inference-addon-llama}
    PRIVATE
      msvcrt.lib
  )
endif()

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

project(qvac-lib-inference-addon-llama C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

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

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message("Building qvac-lib-inference-addon-llama with BACKENDS_SUBDIR='${BACKENDS_SUBDIR_VALUE}'")

# Install dynamic libs to prebuild folder
set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
  endforeach()
endif()

add_bare_module(qvac-lib-inference-addon-llama EXPORTS ${BACKEND_DL_LIBS})

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${qvac-lib-inference-addon-llama}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

  set(ADDON_SOURCES
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  )

  list(APPEND ADDON_SOURCES
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/CacheManager.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/ChatTemplateUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/Qwen3ReasoningUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/QwenTemplate.cpp
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
target_compile_definitions(${qvac-lib-inference-addon-llama} PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}")

# Option to build CLI
option(BUILD_CLI "Build CLI tool example" FALSE)
if(BUILD_CLI)
  # Cache management integration test with automatic model download
  add_executable(cli_tool
    ${PROJECT_SOURCE_DIR}/addon/src/cli/cli_tool.cc
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/CacheManager.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaModel.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/MtmdLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model-interface/TextLlmContext.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/ChatTemplateUtils.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/utils/Qwen3ReasoningUtils.cpp
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
  )
  
  find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "qvac-lib-inference-addon-cpp/JsInterface.hpp")
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
    ${qvac-lib-inference-addon-llama}
    PRIVATE
      msvcrt.lib
  )
endif()

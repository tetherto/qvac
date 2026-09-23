cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(llm-sglang LANGUAGES C CXX)

qvac_addon_project_setup()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/JsInterface.hpp" REQUIRED)

set(PROTOCOL_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/protocol/ChatProtocol.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/http/HttpClient.cpp
)

# This addon speaks HTTP to sglang_cpp_server. It does not link LibTorch or
# the fabric ggml runtime.
add_bare_module(llm-sglang EXPORTS)

target_sources(
  ${llm-sglang}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/src/model/SglangModel.cpp
    ${PROTOCOL_SOURCES}
)

target_include_directories(
  ${llm-sglang}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

find_package(Threads REQUIRED)
target_link_libraries(${llm-sglang} PRIVATE Threads::Threads)

# No fabric module shares a C++ runtime with this addon, so the .bare keeps
# its own static libc++.
qvac_addon_static_cxx_runtime(${llm-sglang}_module)
qvac_addon_finalize(${llm-sglang})

if(BUILD_TESTING)
  enable_testing()
  include(GoogleTest)
  add_subdirectory(test/unit)
endif()

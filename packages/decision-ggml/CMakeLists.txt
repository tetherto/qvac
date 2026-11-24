cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(decision-ggml LANGUAGES C CXX)

qvac_addon_project_setup(VALGRIND_SUPP PRE_COMMIT_HOOK)

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS "inference-addon-cpp/JsInterface.hpp")

# llama / ggml runtime is the shared @qvac/fabric prebuild
# (dynamically linked, loaded once per process); sets qvac_fabric_target.
qvac_addon_use_fabric()

# Sources shared by the addon and the unit-test executable.
set(DECISION_GGML_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/utils.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/logging.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/LlamaLazyInitializeBackend.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/DecisionContext.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/DecisionEngineModel.cpp
)

add_bare_module(decision-ggml EXPORTS)

target_sources(
  ${decision-ggml}
  PRIVATE
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${DECISION_GGML_SOURCES}
)
target_include_directories(
  ${decision-ggml}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

# Upstream server-context (decision execution, no HTTP server), linked
# statically from this addon's vcpkg build of qvac-fabric[server-context], at
# the port version the installed @qvac/fabric records; its llama / common /
# mtmd references resolve from the shared runtime.
qvac_addon_link_fabric_server_context(${decision-ggml})

qvac_addon_link_fabric(${decision-ggml} ${qvac_fabric_target})
qvac_addon_finalize(${decision-ggml})

if(BUILD_TESTING)
  enable_testing()
  add_subdirectory(test/unit)
endif()

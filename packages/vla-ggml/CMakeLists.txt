cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(qvac-lib-infer-vla LANGUAGES C CXX)

qvac_addon_project_setup()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/JsInterface.hpp" REQUIRED)

# ggml runtime is the shared @qvac/fabric prebuild (dynamically linked, loaded
# once per process); sets qvac_fabric_target + BACKENDS_SUBDIR_VALUE.
qvac_addon_use_fabric()

# TEMPORARY PIN - drop once qvac-lib-inference-addon-cpp ships a release that
# compiles against bare-headers >= 1.32.0 and the vcpkg floor is raised.
# bare-headers 1.32.0 (published 2026-09-07 11:58 UTC) changed the `elements`
# parameter of js_set_array_elements() to `js_value_t *const []`, which the
# pinned addon-cpp 1.3.3 header (JsUtils.hpp:531, `const js_value_t **`) can no
# longer compile against - every fresh build after that time fails on all
# platforms. add_bare_module() below fetches bare-headers@latest into _bare via
# cmake-npm, whose install_node_module() keeps an already-present copy, so
# installing the last compatible release first makes it stick. 1.30.0 is the
# version every green build before 2026-09-07 used.
download_bare_headers(_pinned_bare_headers VERSION 1.30.0)

add_bare_module(qvac-lib-infer-vla EXPORTS)

set(ADDON_SOURCES
  ${PROJECT_SOURCE_DIR}/addon/src/js-interface/binding.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/smolvla.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/smolvla_adapter.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/pi05.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/groot.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/model-interface/model_factory.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
  ${PROJECT_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
)

target_sources(
  ${qvac-lib-infer-vla}
  PRIVATE
    ${ADDON_SOURCES}
)

target_include_directories(
  ${qvac-lib-infer-vla}
  PRIVATE
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
    ${PROJECT_SOURCE_DIR}/addon/src
)

qvac_addon_link_fabric(${qvac-lib-infer-vla} ${qvac_fabric_target})

qvac_addon_finalize(${qvac-lib-infer-vla} SUBDIR "${BACKENDS_SUBDIR_VALUE}")

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)
endif()

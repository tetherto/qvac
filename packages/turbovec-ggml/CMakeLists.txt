cmake_minimum_required(VERSION 3.25)

# Shared addon build helpers. See docs/architecture/ADDON-CMAKE-TEMPLATE.md.
include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(turbovec-ggml LANGUAGES C CXX)

qvac_addon_project_setup()

# The vector-index runtime is part of the shared @qvac/fabric prebuild
# (dynamically linked, loaded once per process).
qvac_addon_use_fabric()

add_bare_module(turbovec-ggml EXPORTS)

target_sources(
  ${turbovec-ggml}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/VectorIndex.cpp
)

qvac_addon_link_fabric(${turbovec-ggml} ${qvac_fabric_target})
# No SUBDIR: the index is CPU-only and never loads ggml compute backends.
qvac_addon_finalize(${turbovec-ggml})

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)
endif()

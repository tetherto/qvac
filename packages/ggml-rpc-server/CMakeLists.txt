cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)

qvac_addon_preproject()

project(ggml-rpc-server LANGUAGES C CXX)

qvac_addon_project_setup()

qvac_addon_use_fabric()

add_bare_module(ggml-rpc-server-addon EXPORTS)
target_sources(
  ${ggml-rpc-server-addon}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/binding.cpp
    ${PROJECT_SOURCE_DIR}/addon/rpc-server-core.cpp
)
qvac_addon_link_fabric(${ggml-rpc-server-addon} ${qvac_fabric_target})
qvac_addon_finalize(${ggml-rpc-server-addon})

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)
endif()

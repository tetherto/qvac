cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)

option(RPC_RDMA "Build qvac-fabric RPC with libibverbs/RDMA auto-negotiation support" OFF)
if(RPC_RDMA)
  list(APPEND VCPKG_MANIFEST_FEATURES "rpc-rdma")
endif()

qvac_addon_preproject()

project(ggml-rpc-server LANGUAGES C CXX)

qvac_addon_project_setup()

find_package(OpenSSL)
find_package(llama CONFIG REQUIRED)

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(PREBUILD_DIR "${CMAKE_CURRENT_SOURCE_DIR}/prebuilds/${bare_target_value}/${module_name}")
set(BACKENDS_SUBDIR_VALUE "${bare_target_value}/${module_name}")
message("Building ggml-rpc-server tool bundle at '${PREBUILD_DIR}'")

set(BACKEND_DL_LIBS "")
if((ANDROID OR UNIX OR WIN32) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    if(TARGET ggml::${_backend})
      get_target_property(_backend_type ggml::${_backend} TYPE)
      # Dynamically loaded backends are MODULE targets on some platforms.
      # Static archives must not be copied into the prebuild.
      if(_backend_type STREQUAL "MODULE_LIBRARY" OR _backend_type STREQUAL "SHARED_LIBRARY")
        list(APPEND BACKEND_DL_LIBS INSTALL TARGET ggml::${_backend})
      endif()
    endif()
  endforeach()
endif()

add_bare_module(ggml-rpc-server-addon EXPORTS ${BACKEND_DL_LIBS})
target_sources(
  ${ggml-rpc-server-addon}
  PRIVATE
    ${PROJECT_SOURCE_DIR}/addon/binding.cpp
)
target_link_libraries(${ggml-rpc-server-addon} PRIVATE llama::llama)
qvac_addon_static_cxx_runtime(${ggml-rpc-server-addon}_module)
target_compile_definitions(
  ${ggml-rpc-server-addon}
  PRIVATE BACKENDS_SUBDIR="${BACKENDS_SUBDIR_VALUE}"
)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(${ggml-rpc-server-addon}_module PRIVATE -Wl,--exclude-libs,ALL)
endif()

if(WIN32)
  set(RPC_SERVER_TOOL_NAME "ggml-rpc-server.exe")
else()
  set(RPC_SERVER_TOOL_NAME "ggml-rpc-server")
endif()

find_program(
  GGML_RPC_SERVER_TOOL
  NAMES ${RPC_SERVER_TOOL_NAME}
  PATHS "${CMAKE_BINARY_DIR}/_vcpkg/${VCPKG_TARGET_TRIPLET}/tools/qvac-fabric"
  REQUIRED
  NO_DEFAULT_PATH
)

add_custom_target(
  ggml-rpc-server-tool ALL
  COMMAND ${CMAKE_COMMAND} -E make_directory "${PREBUILD_DIR}"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${GGML_RPC_SERVER_TOOL}"
          "${PREBUILD_DIR}/${RPC_SERVER_TOOL_NAME}"
  COMMENT "Copying ggml-rpc-server to prebuild directory"
)

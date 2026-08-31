cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

set(VCPKG_OVERLAY_TRIPLETS "${CMAKE_CURRENT_SOURCE_DIR}/../../vcpkg-overlays/triplets;${VCPKG_OVERLAY_TRIPLETS}")

project(llm-rpc-server C CXX)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_options(-stdlib=libc++)
  add_link_options(-stdlib=libc++ -static-libstdc++)
endif()

find_path(VCPKG_INSTALLED_PATH share/lint-cpp/.clang-format REQUIRED)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-format
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-format COPYONLY)
configure_file(${VCPKG_INSTALLED_PATH}/share/lint-cpp/.clang-tidy
               ${CMAKE_CURRENT_SOURCE_DIR}/.clang-tidy COPYONLY)

find_package(OpenSSL)
find_package(llama CONFIG REQUIRED)

bare_target(bare_target_value)
bare_module_target("." unused_target NAME module_name VERSION unused_version)
set(PREBUILD_DIR "${CMAKE_CURRENT_SOURCE_DIR}/prebuilds/${bare_target_value}/${module_name}")
message("Building llm-rpc-server tool bundle at '${PREBUILD_DIR}'")

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
  llm-rpc-server-tool ALL
  COMMAND ${CMAKE_COMMAND} -E make_directory "${PREBUILD_DIR}"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${GGML_RPC_SERVER_TOOL}"
          "${PREBUILD_DIR}/${RPC_SERVER_TOOL_NAME}"
  COMMENT "Copying ggml-rpc-server to prebuild directory"
)

if((ANDROID OR UNIX) AND NOT APPLE)
  foreach(_backend ${GGML_AVAILABLE_BACKENDS})
    add_custom_command(
      TARGET llm-rpc-server-tool
      POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
              $<TARGET_FILE:ggml::${_backend}>
              "${PREBUILD_DIR}"
      COMMENT "Copying ggml backend ${_backend} to RPC server prebuild directory"
    )
  endforeach()
endif()

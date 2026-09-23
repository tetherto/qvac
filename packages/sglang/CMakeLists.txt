cmake_minimum_required(VERSION 3.25)

# LibTorch is built against libstdc++. vcpkg-overlays/triplets force
# -stdlib=libc++, so this package keeps cmake-vcpkg's stock Linux triplet.
find_package(cmake-vcpkg REQUIRED PATHS node_modules/cmake-vcpkg)

project(qvac_sglang LANGUAGES NONE)

set(_installed "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}")
set(_stage "${CMAKE_CURRENT_SOURCE_DIR}/dist")

foreach(_tool IN ITEMS sglang_cpp_server sgl_qwen_rank_worker)
  if(NOT EXISTS "${_installed}/bin/${_tool}")
    message(FATAL_ERROR "sglang-cpp did not install ${_installed}/bin/${_tool}")
  endif()
endforeach()

if(NOT EXISTS "${_installed}/lib/sglang-cpp/registry/models-887c401e1.json")
  message(FATAL_ERROR "sglang-cpp did not install the model registry")
endif()

file(REMOVE_RECURSE "${_stage}")
file(MAKE_DIRECTORY "${_stage}/bin" "${_stage}/lib")
file(COPY
  "${_installed}/bin/sglang_cpp_server"
  "${_installed}/bin/sgl_qwen_rank_worker"
  DESTINATION "${_stage}/bin"
  FILE_PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
file(COPY "${_installed}/lib/sglang-cpp" DESTINATION "${_stage}/lib")

file(GLOB _shared_libs
  "${_installed}/lib/*.so"
  "${_installed}/lib/*.so.*")
if(_shared_libs)
  file(COPY ${_shared_libs} DESTINATION "${_stage}/lib")
endif()

message(STATUS "Staged SGLang server at ${_stage}/bin/sglang_cpp_server")

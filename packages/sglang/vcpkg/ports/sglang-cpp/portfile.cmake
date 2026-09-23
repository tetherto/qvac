# Experimental overlay port for jpgaribotti/sglang-cpp.
#
# Builds the production binaries (sglang_cpp_server and sgl_qwen_rank_worker)
# and installs the packaged AOT kernels. Smoke-test executables are not part
# of the install target, so `cmake --target install` does not compile them.
#
# The server target exists only when QSA AOT is enabled, which upstream gates
# on SGL_TVM_FFI_ROOT and SGL_SGLANG_KERNEL_ROOT. CUDA, LibTorch, NCCL, ZeroMQ,
# msgpack, and libunistring are located the same way upstream CMake does:
# on the host, not as vcpkg ports. Official LibTorch is libstdc++; do not
# build this port with the monorepo libc++ triplets.

set(VCPKG_BUILD_TYPE release)
set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)
set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_POLICY_ALLOW_EXES_IN_BIN enabled)
set(VCPKG_POLICY_SKIP_ABSOLUTE_PATHS_CHECK enabled)

foreach(_required IN ITEMS SGL_TVM_FFI_ROOT SGL_SGLANG_KERNEL_ROOT)
  if(NOT DEFINED ENV{${_required}} OR "$ENV{${_required}}" STREQUAL "")
    message(FATAL_ERROR
      "sglang-cpp requires ${_required} so the port can build sglang_cpp_server")
  endif()
endforeach()

if((NOT DEFINED ENV{Torch_DIR} OR "$ENV{Torch_DIR}" STREQUAL "")
   AND (NOT DEFINED ENV{CMAKE_PREFIX_PATH} OR "$ENV{CMAKE_PREFIX_PATH}" STREQUAL ""))
  message(FATAL_ERROR
    "sglang-cpp requires Torch_DIR or CMAKE_PREFIX_PATH pointing at LibTorch")
endif()

if(DEFINED ENV{GITHUB_TOKEN} AND NOT "$ENV{GITHUB_TOKEN}" STREQUAL "")
  set(_sglang_auth "$ENV{GITHUB_TOKEN}")
elseif(DEFINED ENV{GH_TOKEN} AND NOT "$ENV{GH_TOKEN}" STREQUAL "")
  set(_sglang_auth "$ENV{GH_TOKEN}")
else()
  message(FATAL_ERROR
    "jpgaribotti/sglang-cpp is private. Export GITHUB_TOKEN or GH_TOKEN "
    "before configuring (gh auth token).")
endif()

vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO jpgaribotti/sglang-cpp
  REF 9901aa955e1eadf1ee96416b28e718859e7a7c2f
  SHA512 f39ee5d67c30d86c4eb34b6c337134437743192691b7f0ce86c97398abba317ffec7c354ac564470c43907cfff58d5f841e3d9d992c42138dd596e39485a7382
  AUTHORIZATION_TOKEN "${_sglang_auth}"
)

set(_sglang_options "")
macro(sglang_option env_name)
  if(DEFINED ENV{${env_name}} AND NOT "$ENV{${env_name}}" STREQUAL "")
    list(APPEND _sglang_options "-D${env_name}=$ENV{${env_name}}")
  endif()
endmacro()

sglang_option(Torch_DIR)
sglang_option(SGL_CUDA_ROOT)
sglang_option(SGL_NCCL_ROOT)
sglang_option(SGL_ZMQ_ROOT)
sglang_option(SGL_MSGPACK_ROOT)
sglang_option(SGL_XGRAMMAR_ROOT)
sglang_option(SGL_TVM_FFI_ROOT)
sglang_option(SGL_SGLANG_KERNEL_ROOT)
sglang_option(SGL_CUDA_ARCH)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  OPTIONS
    ${_sglang_options}
)

vcpkg_cmake_install()

# Upstream installs kernels at lib/sglang-cpp/<arch> and does not install the
# model registry. The server accepts the parent directory when it contains
# both <arch>/ and registry/models-887c401e1.json.
file(COPY "${SOURCE_PATH}/registry/models-887c401e1.json"
  DESTINATION "${CURRENT_PACKAGES_DIR}/lib/sglang-cpp/registry")

if(NOT EXISTS "${CURRENT_PACKAGES_DIR}/bin/sglang_cpp_server"
   OR NOT EXISTS "${CURRENT_PACKAGES_DIR}/bin/sgl_qwen_rank_worker")
  message(FATAL_ERROR
    "sglang-cpp did not install sglang_cpp_server and sgl_qwen_rank_worker")
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug")

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage"
  DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/copyright"
  DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")

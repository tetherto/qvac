# Experimental overlay port for jpgaribotti/sglang-cpp.
#
# Builds the server and worker. Kernel packages may be built separately and
# supplied via QVAC_GRID_PACKAGE_DIR.
#
# CUDA, LibTorch, NCCL, TVM-FFI and the other development libraries are
# located by upstream CMake on the host. Official LibTorch uses libstdc++;
# do not build this port with the monorepo libc++ triplets.

set(VCPKG_BUILD_TYPE release)
set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)
set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_POLICY_ALLOW_EXES_IN_BIN enabled)
set(VCPKG_POLICY_SKIP_ABSOLUTE_PATHS_CHECK enabled)

foreach(_required IN ITEMS QVAC_GRID_TVM_FFI_ROOT)
  if(NOT DEFINED ENV{${_required}} OR "$ENV{${_required}}" STREQUAL "")
    message(FATAL_ERROR
      "sglang-cpp requires ${_required} so the port can build qvac_grid_server")
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
  REF de1d78416f47a4fc541ca96af582b2f63429be2f
  SHA512 217af81b0e2f974cdb9dd377e2e5d2ba3f4d2a6d57f95b1e3a0f2a46c34e825520306f9ec9ffffe3f9ac847e2f0b4badea6d53ce4d82def02a20a14bdd41d6c6
  AUTHORIZATION_TOKEN "${_sglang_auth}"
)

# vcpkg disables FetchContent downloads during configure. Fetch and apply the
# exact upstream patch set up front, then provide the prepared source tree.
file(GLOB _upstream_patches "${SOURCE_PATH}/patches/sglang/*.patch")
list(SORT _upstream_patches)
vcpkg_from_github(
  OUT_SOURCE_PATH UPSTREAM_SGLANG_SOURCE
  REPO sgl-project/sglang
  REF 390acf84e31d3b63dac64e021911d94770e55a8c
  SHA512 b64059349c32de59f33a27badcc302eb166d209d4acf963c494b72ca9ba55eb2b0d2ffb9854ebdf980ed6d6b7396fd1424f43e1c60f61b059a80465e7bdffb40
  PATCHES ${_upstream_patches}
)

set(_sglang_options "")
macro(sglang_option env_name)
  if(DEFINED ENV{${env_name}} AND NOT "$ENV{${env_name}}" STREQUAL "")
    list(APPEND _sglang_options "-D${env_name}=$ENV{${env_name}}")
  endif()
endmacro()

sglang_option(Torch_DIR)
sglang_option(QVAC_GRID_CUDA_ROOT)
sglang_option(QVAC_GRID_NCCL_ROOT)
sglang_option(QVAC_GRID_ZMQ_ROOT)
sglang_option(QVAC_GRID_MSGPACK_ROOT)
sglang_option(QVAC_GRID_XGRAMMAR_ROOT)
sglang_option(QVAC_GRID_TVM_FFI_ROOT)
sglang_option(QVAC_GRID_FLASHINFER_ROOT)
sglang_option(QVAC_GRID_CUDA_ARCH)
sglang_option(QVAC_GRID_PACKAGE_DIR)
sglang_option(QVAC_GRID_BUILD_AOT_KERNELS)
sglang_option(QVAC_GRID_DEP_MIRROR)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  OPTIONS
    ${_sglang_options}
    -DQVAC_GRID_BUILD_TESTS=OFF
    "-DQVAC_GRID_SOURCE_DIR_sglang=${UPSTREAM_SGLANG_SOURCE}"
)

vcpkg_cmake_install()

if(NOT EXISTS "${CURRENT_PACKAGES_DIR}/bin/qvac_grid_server"
   OR NOT EXISTS "${CURRENT_PACKAGES_DIR}/bin/qvac_grid_rank_worker")
  message(FATAL_ERROR
    "sglang-cpp did not install qvac_grid_server and qvac_grid_rank_worker")
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug")

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage"
  DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/copyright"
  DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")

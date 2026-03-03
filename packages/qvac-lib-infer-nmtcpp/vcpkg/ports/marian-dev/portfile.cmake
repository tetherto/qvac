vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-ext-marian-dev
  REF 26273d1120694b0c5b188cc8c2eafd6aa2450367
  SHA512 e68f6b6c1db7350d70764e5d866373fd79615b6e639d429d4edc5df496b39324009ea276b4781178921e33b4e269fe80395630a859b2bd017d39a3a7b18d1546
  PATCHES
    git_revision.patch
    fix-marian-disable-wx.patch
    preserve-cxx-flags.patch
    fix-faiss-missing-intrinsics.patch
)

set(_BUILD_ARCH_OPT "")
if(VCPKG_TARGET_IS_ANDROID)
    if(VCPKG_TARGET_ARCHITECTURE MATCHES "arm64|ARM64|aarch64")
    set(_BUILD_ARCH_OPT "-DBUILD_ARCH=armv8-a")
  endif()
endif()

if(VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
  if(VCPKG_TARGET_IS_LINUX OR VCPKG_TARGET_IS_OSX OR VCPKG_TARGET_IS_IOS)
    set(_BUILD_ARCH_OPT "-DBUILD_ARCH=x86-64-v2")
  endif()
endif()

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DCOMPILE_CPU=ON
    -DCOMPILE_CUDA=OFF
    -DCOMPILE_EXAMPLES=OFF
    -DCOMPILE_SERVER=OFF
    -DCOMPILE_TESTS=OFF
    -DUSE_CCACHE=OFF
    -DUSE_CUDNN=OFF
    -DUSE_DOXYGEN=OFF
    -DUSE_FBGEMM=OFF
    -DUSE_MPI=OFF
    -DUSE_NCCL=OFF
    -DUSE_ONNX=OFF
    -DUSE_SENTENCEPIECE=ON
    -DUSE_EXTERNAL_SENTENCEPIECE=ON
    -DUSE_STATIC_LIBS=ON
    -DCOMPILE_WASM=OFF
    -DUSE_WASM_COMPATIBLE_SOURCE=OFF
    -DGENERATE_MARIAN_INSTALL_TARGETS=ON
    ${_BUILD_ARCH_OPT}
)

vcpkg_cmake_build()
vcpkg_cmake_install()

vcpkg_cmake_config_fixup(
  PACKAGE_NAME marian
  CONFIG_PATH lib/cmake/marian
)

vcpkg_copy_pdbs()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/marian-devConfig.cmake" [=[
get_filename_component(PACKAGE_PREFIX_DIR "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
include("${PACKAGE_PREFIX_DIR}/share/marian/marianConfig.cmake")
if(TARGET marian::marian AND NOT TARGET marian-dev::marian-dev)
  add_library(marian-dev::marian-dev ALIAS marian::marian)
endif()
]=])

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE.md")



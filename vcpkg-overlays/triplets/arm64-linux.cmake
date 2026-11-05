set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Linux)

set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/linux-clang.cmake")
set(VCPKG_C_FLAGS "-fPIC")
set(VCPKG_CXX_FLAGS "-fPIC -stdlib=libc++")
set(VCPKG_LINKER_FLAGS "-stdlib=libc++")

# Build only Release configuration to avoid vcpkg debug dependency builds in CI.
set(VCPKG_BUILD_TYPE release)

# Hash the provisioned toolkit into the CUDA ports' ABI. setup-cuda keeps
# CUDACXX and CUDA_PATH in the build environment via VCPKG_KEEP_ENV_VARS.
if(PORT STREQUAL "qvac-fabric" OR PORT STREQUAL "ggml")
  list(APPEND VCPKG_ENV_PASSTHROUGH QVAC_CUDA_TOOLKIT)
endif()

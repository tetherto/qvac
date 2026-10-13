set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Linux)

set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/linux-clang.cmake")
set(VCPKG_C_FLAGS "-fPIC")
set(VCPKG_CXX_FLAGS "-fPIC -stdlib=libc++")
set(VCPKG_LINKER_FLAGS "-stdlib=libc++")

# Build only Release configuration to avoid vcpkg debug dependency builds in CI.
set(VCPKG_BUILD_TYPE release)

# QVAC-23763: hash the CUDA toolkit setup-cuda provisioned into qvac-fabric's
# ABI only, so a host-toolkit CUDA build never shares a cache entry with a
# pinned one.
if(PORT STREQUAL "qvac-fabric")
  set(VCPKG_ENV_PASSTHROUGH QVAC_CUDA_TOOLKIT)
endif()

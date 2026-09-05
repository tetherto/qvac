set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Linux)

set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/linux-clang.cmake")
set(VCPKG_C_FLAGS "-fPIC")
set(VCPKG_CXX_FLAGS "-fPIC -stdlib=libc++")
set(VCPKG_LINKER_FLAGS "-stdlib=libc++")

# A distinct triplet keeps the CUDA 12 Jetson package separate from the CUDA 13
# SBSA package in vcpkg's binary cache.
set(VCPKG_BUILD_TYPE release)

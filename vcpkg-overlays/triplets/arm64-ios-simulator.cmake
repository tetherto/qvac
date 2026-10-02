set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME iOS)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/apple-clang.cmake")
# No VCPKG_OSX_DEPLOYMENT_TARGET: the chainloaded bare-make toolchain sets
# CMAKE_OSX_DEPLOYMENT_TARGET, which would shadow a value set here.
set(VCPKG_OSX_SYSROOT iphonesimulator)

# Build only Release configuration to avoid vcpkg debug dependency builds in CI.
set(VCPKG_BUILD_TYPE release)

set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/apple-clang.cmake")
set(VCPKG_OSX_ARCHITECTURES x86_64)
# No VCPKG_OSX_DEPLOYMENT_TARGET: the chainloaded bare-make toolchain sets
# CMAKE_OSX_DEPLOYMENT_TARGET, which would shadow a value set here.

# Build only Release configuration to avoid vcpkg debug dependency builds in CI.
set(VCPKG_BUILD_TYPE release)

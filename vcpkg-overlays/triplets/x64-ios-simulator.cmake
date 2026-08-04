set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME iOS)
set(VCPKG_OSX_DEPLOYMENT_TARGET 14.0)
set(VCPKG_OSX_SYSROOT iphonesimulator)

# Build only Release configuration to avoid vcpkg debug dependency builds in CI.
set(VCPKG_BUILD_TYPE release)

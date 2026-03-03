set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_OSX_ARCHITECTURES x86_64)
set(VCPKG_OSX_DEPLOYMENT_TARGET 13.0)
message(STATUS "VCPKG_OSX_DEPLOYMENT_TARGET by triplet override: ${VCPKG_OSX_DEPLOYMENT_TARGET}")

# Disable array-bounds warning for onnxruntime MLAS AVX2/AVX512 code
# Known issue with Clang on x64 macOS - false positive in template code
set(VCPKG_CXX_FLAGS "-Wno-array-bounds")
set(VCPKG_C_FLAGS "-Wno-array-bounds")


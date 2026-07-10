include("${CMAKE_CURRENT_LIST_DIR}/../../../../vcpkg-overlays/triplets/x64-osx.cmake")

set(VCPKG_OSX_DEPLOYMENT_TARGET 13.3)

# Disable array-bounds warning for onnxruntime MLAS AVX2/AVX512 code
# Known issue with Clang on x64 macOS - false positive in template code
set(VCPKG_CXX_FLAGS "-Wno-array-bounds")
set(VCPKG_C_FLAGS "-Wno-array-bounds")

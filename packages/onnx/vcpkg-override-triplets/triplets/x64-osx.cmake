include("${CMAKE_CURRENT_LIST_DIR}/../../../../vcpkg-overlays/triplets/x64-osx.cmake")

set(VCPKG_OSX_DEPLOYMENT_TARGET 13.3)
set(VCPKG_CXX_FLAGS "-Wno-array-bounds")
set(VCPKG_C_FLAGS "-Wno-array-bounds")

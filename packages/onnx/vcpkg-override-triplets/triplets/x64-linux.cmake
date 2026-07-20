include("${CMAKE_CURRENT_LIST_DIR}/../../../../vcpkg-overlays/triplets/x64-linux.cmake")

set(VCPKG_C_FLAGS "-fPIC -Wno-array-bounds")
set(VCPKG_CXX_FLAGS "-fPIC -stdlib=libc++ -Wno-array-bounds")

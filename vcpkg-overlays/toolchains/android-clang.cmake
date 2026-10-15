# Compiler comes from bare-make's Android toolchain, which selects the NDK
# clang. The STL follows the triplet's CRT linkage; bare-make would otherwise
# leave ANDROID_STL at none.

if(NOT DEFINED ANDROID_STL)
  if(VCPKG_CRT_LINKAGE STREQUAL "static")
    set(ANDROID_STL c++_static)
  else()
    set(ANDROID_STL c++_shared)
  endif()
endif()

if(VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
  set(_qvac_bare_make_toolchain_name "android-arm64.cmake")
else()
  message(FATAL_ERROR
    "qvac android-clang: no bare-make toolchain for VCPKG_TARGET_ARCHITECTURE='${VCPKG_TARGET_ARCHITECTURE}'")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/include-bare-make-toolchain.cmake")

include("$ENV{VCPKG_ROOT}/scripts/toolchains/android.cmake")

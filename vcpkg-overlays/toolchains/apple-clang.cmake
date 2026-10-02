# Compiler comes from bare-make's Darwin or iOS toolchain (llvm-runtime clang).
# vcpkg's osx.cmake / ios.cmake still apply the triplet's flags. The bare-make
# file also sets the deployment target (macOS 13, iOS 15), so ports match the
# addon built on top of them.

if(VCPKG_TARGET_TRIPLET STREQUAL "arm64-osx")
  set(_qvac_bare_make_toolchain_name "darwin-arm64.cmake")
  set(_qvac_vcpkg_platform_toolchain "osx.cmake")
elseif(VCPKG_TARGET_TRIPLET STREQUAL "x64-osx")
  set(_qvac_bare_make_toolchain_name "darwin-x64.cmake")
  set(_qvac_vcpkg_platform_toolchain "osx.cmake")
elseif(VCPKG_TARGET_TRIPLET STREQUAL "arm64-ios")
  set(_qvac_bare_make_toolchain_name "ios-arm64.cmake")
  set(_qvac_vcpkg_platform_toolchain "ios.cmake")
elseif(VCPKG_TARGET_TRIPLET STREQUAL "arm64-ios-simulator")
  set(_qvac_bare_make_toolchain_name "ios-arm64-simulator.cmake")
  set(_qvac_vcpkg_platform_toolchain "ios.cmake")
elseif(VCPKG_TARGET_TRIPLET STREQUAL "x64-ios-simulator")
  set(_qvac_bare_make_toolchain_name "ios-x64-simulator.cmake")
  set(_qvac_vcpkg_platform_toolchain "ios.cmake")
else()
  message(FATAL_ERROR
    "qvac apple-clang: no bare-make toolchain for VCPKG_TARGET_TRIPLET='${VCPKG_TARGET_TRIPLET}'")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/include-bare-make-toolchain.cmake")

include("$ENV{VCPKG_ROOT}/scripts/toolchains/${_qvac_vcpkg_platform_toolchain}")
unset(_qvac_vcpkg_platform_toolchain)

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

# TEMP: vcpkg's android.cmake string(APPEND)s the VCPKG_* flags onto
# CMAKE_<LANG>_FLAGS[_<CONFIG>] and the CMAKE_<TYPE>_LINKER_FLAGS[_<CONFIG>]
# variables. The legacy NDK toolchain (cmake-toolchains < 2.4) seeds these
# first, but the current one leaves them to CMake. The append then creates a
# blank normal variable that shadows the cache default (CMP0126 NEW), so
# Release builds lose -O3 -DNDEBUG and compile at -O0. Move the vcpkg flags
# into *_INIT instead, so CMake folds them into its defaults.
foreach(_qvac_var IN ITEMS C_FLAGS CXX_FLAGS ASM_FLAGS
    EXE_LINKER_FLAGS SHARED_LINKER_FLAGS MODULE_LINKER_FLAGS)
  foreach(_qvac_cfg IN ITEMS "" _DEBUG _RELEASE)
    set(_qvac_name "CMAKE_${_qvac_var}${_qvac_cfg}")
    if(DEFINED ${_qvac_name} AND NOT DEFINED CACHE{${_qvac_name}})
      string(APPEND ${_qvac_name}_INIT " ${${_qvac_name}}")
      unset(${_qvac_name})
    endif()
  endforeach()
endforeach()
unset(_qvac_var)
unset(_qvac_cfg)
unset(_qvac_name)

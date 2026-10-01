# Compiler and LLVM tools come from bare-make's win32 toolchain (clang-cl,
# lld-link, llvm-lib, llvm-nm). vcpkg's windows.cmake still applies the
# triplet's CRT and warning flags.

# Port builds do not inherit VCPKG_ROOT. This file is chainloaded by
# <root>/scripts/buildsystems/vcpkg.cmake, including in try_compile projects.
# Read the parent before any include() below replaces it.
cmake_path(GET CMAKE_PARENT_LIST_FILE PARENT_PATH _qvac_vcpkg_scripts)
cmake_path(GET _qvac_vcpkg_scripts PARENT_PATH _qvac_vcpkg_scripts)

if(VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
  set(_qvac_bare_make_toolchain_name "win32-x64.cmake")
elseif(VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
  set(_qvac_bare_make_toolchain_name "win32-arm64.cmake")
else()
  message(FATAL_ERROR
    "qvac windows-clang: no bare-make toolchain for VCPKG_TARGET_ARCHITECTURE='${VCPKG_TARGET_ARCHITECTURE}'")
endif()

set(_qvac_bare_make_label "qvac windows-clang")
include("${CMAKE_CURRENT_LIST_DIR}/include-bare-make-toolchain.cmake")

# vcpkg configures ports with its own CMake, which links MSVC-style targets
# through CMAKE_LINKER and ignores the LLD linker type bare-make selects. With
# a chainloaded toolchain vcpkg loads no vcvars, so link.exe is not found either.
if(CMAKE_LINKER_LLD)
  set(CMAKE_LINKER "${CMAKE_LINKER_LLD}" CACHE FILEPATH "Linker used by vcpkg ports" FORCE)
endif()

include("${_qvac_vcpkg_scripts}/toolchains/windows.cmake")
unset(_qvac_vcpkg_scripts)

# windows.cmake writes CMAKE_<LANG>_FLAGS into the cache, which drops the
# resource-dir and -B flags bare-make put in FLAGS_INIT. llvm-runtime does
# not lay those out next to clang-cl, so put them back on the cache flags.
foreach(_qvac_lang IN ITEMS C CXX)
  if(NOT CMAKE_${_qvac_lang}_FLAGS_INIT)
    continue()
  endif()
  string(FIND "${CMAKE_${_qvac_lang}_FLAGS}" "${CMAKE_${_qvac_lang}_FLAGS_INIT}" _qvac_flags_pos)
  if(_qvac_flags_pos EQUAL -1)
    set(CMAKE_${_qvac_lang}_FLAGS
      "${CMAKE_${_qvac_lang}_FLAGS} ${CMAKE_${_qvac_lang}_FLAGS_INIT}"
      CACHE STRING "" FORCE)
  endif()
endforeach()
unset(_qvac_lang)
unset(_qvac_flags_pos)

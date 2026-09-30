# Compiler, linker, and target triple come from the bare-make toolchain that
# launched this build. This file only adds what that toolchain does not know
# about: vcpkg's Linux flag application (the triplet's -fPIC / libc++ flags)
# and the CUDA host compiler.

if(VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
  set(_qvac_bare_make_toolchain_name "linux-x64.cmake")
elseif(VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
  set(_qvac_bare_make_toolchain_name "linux-arm64.cmake")
else()
  message(FATAL_ERROR
    "qvac linux-clang: no bare-make toolchain for VCPKG_TARGET_ARCHITECTURE='${VCPKG_TARGET_ARCHITECTURE}'")
endif()

if(DEFINED ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE} AND EXISTS "$ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE}")
  set(_qvac_bare_make_toolchain "$ENV{QVAC_BARE_MAKE_TOOLCHAIN_FILE}")
else()
  find_program(_qvac_bare_make_bin bare-make)
  if(NOT _qvac_bare_make_bin)
    message(FATAL_ERROR
      "qvac linux-clang: bare-make is not on PATH and QVAC_BARE_MAKE_TOOLCHAIN_FILE is unset")
  endif()
  file(REAL_PATH "${_qvac_bare_make_bin}" _qvac_bare_make_real)
  get_filename_component(_qvac_bare_make_root "${_qvac_bare_make_real}" DIRECTORY)
  # npm nests cmake-toolchains under a global bare-make
  # (`<prefix>/node_modules/bare-make/node_modules/cmake-toolchains`).
  # A local `npm install` hoists it next to the package
  # (`<project>/node_modules/cmake-toolchains`). The bin is bin.js in the
  # package root, or a .bin shim whose real path stays in node_modules/.bin.
  foreach(_qvac_bare_make_candidate IN ITEMS
      "${_qvac_bare_make_root}/node_modules/cmake-toolchains/${_qvac_bare_make_toolchain_name}"
      "${_qvac_bare_make_root}/../node_modules/cmake-toolchains/${_qvac_bare_make_toolchain_name}"
      "${_qvac_bare_make_root}/../cmake-toolchains/${_qvac_bare_make_toolchain_name}"
      "${_qvac_bare_make_root}/../../cmake-toolchains/${_qvac_bare_make_toolchain_name}")
    if(EXISTS "${_qvac_bare_make_candidate}")
      file(REAL_PATH "${_qvac_bare_make_candidate}" _qvac_bare_make_toolchain)
      break()
    endif()
  endforeach()
  if(NOT _qvac_bare_make_toolchain)
    set(_qvac_bare_make_toolchain
      "${_qvac_bare_make_root}/node_modules/cmake-toolchains/${_qvac_bare_make_toolchain_name}")
  endif()
endif()

if(NOT EXISTS "${_qvac_bare_make_toolchain}")
  message(FATAL_ERROR
    "qvac linux-clang: bare-make toolchain not found: ${_qvac_bare_make_toolchain}")
endif()

set(QVAC_BARE_MAKE_TOOLCHAIN_FILE "${_qvac_bare_make_toolchain}" CACHE FILEPATH
  "bare-make toolchain forwarded to ExternalProject host tools" FORCE)
message(STATUS "qvac linux-clang: using bare-make toolchain ${QVAC_BARE_MAKE_TOOLCHAIN_FILE}")

include("${QVAC_BARE_MAKE_TOOLCHAIN_FILE}")

# CMAKE_LINKER_TYPE applies to every language enabled later. bare-make sets
# it to LLD, and CMake's HIP toolchain does not implement that linker type
# (enable_language(HIP) fails the ABI try_compile). Keep LLD on the host
# languages and leave HIP on the linker its own toolchain selects.
if(CMAKE_LINKER_TYPE)
  foreach(_qvac_lang IN ITEMS C CXX ASM)
    if(NOT CMAKE_${_qvac_lang}_LINKER_TYPE)
      set(CMAKE_${_qvac_lang}_LINKER_TYPE "${CMAKE_LINKER_TYPE}")
    endif()
  endforeach()
  unset(CMAKE_LINKER_TYPE)
  unset(CMAKE_LINKER_TYPE CACHE)
  unset(_qvac_lang)
endif()

# That include registers cmake-toolchains' ExternalProject hook, which
# forwards vcpkg.cmake. Drop it and forward the bare-make file instead.
if(CMAKE_PROJECT_INCLUDE)
  list(FILTER CMAKE_PROJECT_INCLUDE EXCLUDE REGEX "/external-project/forward-toolchain\\.cmake$")
endif()
list(APPEND CMAKE_PROJECT_INCLUDE "${CMAKE_CURRENT_LIST_DIR}/forward-bare-make-toolchain.cmake")
list(REMOVE_DUPLICATES CMAKE_PROJECT_INCLUDE)

include("$ENV{VCPKG_ROOT}/scripts/toolchains/linux.cmake")

# CUDA objects link through the CUDA host compiler, which defaults to g++.
# The triplet adds -stdlib=libc++, which g++ rejects, so the host compiler
# has to be the same clang++ the rest of the build uses.
set(CMAKE_CUDA_HOST_COMPILER "${CMAKE_CXX_COMPILER}")

# nvcc's host_config.h caps the supported clang major below the monorepo's
# clang. The cap is a support statement, not an incompatibility: host code
# still compiles with the same clang++ as the rest of the build, and the
# CUDA integration lane validates the combination end to end.
set(CMAKE_CUDA_FLAGS_INIT "-allow-unsupported-compiler")

unset(_qvac_bare_make_toolchain_name)
unset(_qvac_bare_make_toolchain)
unset(_qvac_bare_make_bin)
unset(_qvac_bare_make_real)
unset(_qvac_bare_make_root)
unset(_qvac_bare_make_candidate)

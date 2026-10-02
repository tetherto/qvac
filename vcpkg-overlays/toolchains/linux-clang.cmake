if(VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
  set(_qvac_bare_make_toolchain_name "linux-x64.cmake")
elseif(VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
  set(_qvac_bare_make_toolchain_name "linux-arm64.cmake")
else()
  message(FATAL_ERROR
    "qvac linux-clang: no bare-make toolchain for VCPKG_TARGET_ARCHITECTURE='${VCPKG_TARGET_ARCHITECTURE}'")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/include-bare-make-toolchain.cmake")

# CUDA objects link through the CUDA host compiler, which defaults to g++.
# This toolchain adds -stdlib=libc++, which g++ rejects, so the host compiler
# has to be the same clang++ the rest of the build uses.
set(CMAKE_CUDA_HOST_COMPILER "${CMAKE_CXX_COMPILER}")

# nvcc's host_config.h caps the supported clang major below the monorepo's
# clang. The cap is a support statement, not an incompatibility: host code
# still compiles with the same clang++ as the rest of the build, and the
# CUDA integration lane validates the combination end to end.
set(CMAKE_CUDA_FLAGS_INIT "-allow-unsupported-compiler")

include("$ENV{VCPKG_ROOT}/scripts/toolchains/linux.cmake")

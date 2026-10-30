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

# HIP sources compile through their own driver, which never sees
# VCPKG_CXX_FLAGS. Their host code would then use libstdc++ while the module
# links libc++, leaving libstdc++ symbols undefined, and the module loads only
# in a process that already has libstdc++ mapped. CUDA cannot take the same
# fix: nvcc before 13.4 rejects libc++ host code, so the qvac-fabric port
# builds its CUDA module against libstdc++ instead.
if(VCPKG_CXX_FLAGS MATCHES "(^| )-stdlib=libc\\+\\+( |$)")
  # HIP stays on ROCm's clang: bare-make's has no AMDGPU backend. ROCm's own
  # libc++ headers do not build (no __config_site) and it ships no libc++.a, so
  # HIP takes the headers of the libc++ the C++ compiler links.
  # -stdlib++-isystem, unlike -isystem, keeps them after clang's HIP math
  # wrappers.
  set(_qvac_libcxx_target)
  if(CMAKE_CXX_COMPILER_TARGET)
    set(_qvac_libcxx_target "--target=${CMAKE_CXX_COMPILER_TARGET}")
  endif()
  execute_process(
    COMMAND "${CMAKE_CXX_COMPILER}" ${_qvac_libcxx_target} -stdlib=libc++ -E -v -x c++ /dev/null
    OUTPUT_QUIET
    ERROR_VARIABLE _qvac_libcxx_search
    RESULT_VARIABLE _qvac_libcxx_result)
  string(REGEX MATCH "\n *([^\n]*/c\\+\\+/v1)\n" _qvac_libcxx_match "${_qvac_libcxx_search}")
  if(NOT _qvac_libcxx_result EQUAL 0 OR NOT IS_DIRECTORY "${CMAKE_MATCH_1}")
    message(FATAL_ERROR "qvac linux-clang: ${CMAKE_CXX_COMPILER} reports no libc++ headers for -stdlib=libc++")
  endif()
  set(CMAKE_HIP_FLAGS_INIT "-stdlib=libc++ -stdlib++-isystem ${CMAKE_MATCH_1}")

  unset(_qvac_libcxx_target)
  unset(_qvac_libcxx_search)
  unset(_qvac_libcxx_result)
  unset(_qvac_libcxx_match)
endif()

include("$ENV{VCPKG_ROOT}/scripts/toolchains/linux.cmake")

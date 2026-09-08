set(CMAKE_C_COMPILER "clang")
set(CMAKE_CXX_COMPILER "clang++")

# CUDA objects link through the CUDA host compiler, which defaults to g++.
# This toolchain adds -stdlib=libc++, which g++ rejects, so the host compiler
# has to be the same clang++ the rest of the build uses.
set(CMAKE_CUDA_HOST_COMPILER "clang++")

# nvcc's host_config.h caps the supported clang major below the monorepo's
# clang. The cap is a support statement, not an incompatibility: host code
# still compiles with the same clang++ as the rest of the build, and the
# CUDA integration lane validates the combination end to end.
set(CMAKE_CUDA_FLAGS_INIT "-allow-unsupported-compiler")

include("$ENV{VCPKG_ROOT}/scripts/toolchains/linux.cmake")

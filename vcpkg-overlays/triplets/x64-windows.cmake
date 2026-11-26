# Static port libraries use the shared MSVC CRT, matching addon compilation
# in cmake/qvac-addon/windows-runtime.cmake. Fabric ships the Release CRT DLLs.
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/windows-clang.cmake")
set(VCPKG_ENV_PASSTHROUGH_UNTRACKED QVAC_BARE_MAKE_TOOLCHAIN_FILE CMAKE_PROGRAM_PATH)
set(VCPKG_BUILD_TYPE release)
set(VCPKG_CXX_FLAGS "/wd4709")
set(VCPKG_C_FLAGS "/wd4709")

# setup-cuda pins the VS 2022 toolset that CUDA supports. Keep vcpkg from
# reselecting the newest installed compiler when it loads vcvars.
if(DEFINED ENV{QVAC_MSVC_INSTALLATION} AND DEFINED ENV{QVAC_MSVC_VERSION})
  set(VCPKG_VISUAL_STUDIO_PATH "$ENV{QVAC_MSVC_INSTALLATION}")
  set(VCPKG_PLATFORM_TOOLSET v143)
  set(VCPKG_PLATFORM_TOOLSET_VERSION "$ENV{QVAC_MSVC_VERSION}")
endif()

# Hash the provisioned toolkit into the CUDA ports' ABI. setup-cuda keeps
# CUDACXX and CUDA_PATH in the build environment via VCPKG_KEEP_ENV_VARS.
if(PORT STREQUAL "qvac-fabric" OR PORT STREQUAL "ggml")
  list(APPEND VCPKG_ENV_PASSTHROUGH QVAC_CUDA_TOOLKIT)
endif()

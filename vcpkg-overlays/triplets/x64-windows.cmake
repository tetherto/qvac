# Static CRT + static library linkage so addons do not acquire a runtime
# dependency on the dynamic Visual C++ runtime (vcruntime140.dll / msvcp140.dll).
# This matches the bare-make win32 toolchain, which compiles the addon itself
# with the static MSVC runtime (CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded...").
set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE static)
set(VCPKG_LIBRARY_LINKAGE static)
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

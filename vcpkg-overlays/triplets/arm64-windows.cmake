# Static CRT + static library linkage so addons do not acquire a runtime
# dependency on the dynamic Visual C++ runtime (vcruntime140.dll / msvcp140.dll).
# This matches the bare-make win32 toolchain, which compiles the addon itself
# with the static MSVC runtime (CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded...").
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE static)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_BUILD_TYPE release)
set(VCPKG_CXX_FLAGS "/wd4709")
set(VCPKG_C_FLAGS "/wd4709")

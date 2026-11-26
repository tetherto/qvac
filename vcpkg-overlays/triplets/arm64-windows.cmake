# Static port libraries use the shared MSVC CRT, matching addon compilation
# in cmake/qvac-addon/windows-runtime.cmake. Fabric ships the Release CRT DLLs.
set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/windows-clang.cmake")
set(VCPKG_ENV_PASSTHROUGH_UNTRACKED QVAC_BARE_MAKE_TOOLCHAIN_FILE CMAKE_PROGRAM_PATH)
set(VCPKG_BUILD_TYPE release)
set(VCPKG_CXX_FLAGS "/wd4709")
set(VCPKG_C_FLAGS "/wd4709")

set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME Linux)

# stable-diffusion.cpp uses Clang-only warning flags (-Wunreachable-code-break,
# -Wunreachable-code-return) that GCC does not support, so we must build with clang.
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/clang-linux.cmake")

# Static libs are linked into a shared .bare addon, so all objects must be PIC.
set(VCPKG_C_FLAGS "-fPIC")
set(VCPKG_CXX_FLAGS "-fPIC")

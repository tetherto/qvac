vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO google/benchmark
    REF "v${VERSION}"
    SHA512 fc787d3d60a55abb3edaa575bf947c72e1ad1404a35bfddf585299411bcd04d32503bba563f9a36dccf128fce6261b97d460d6c293ed2c2d0807cf0154c86aa7
    HEAD_REF main
)

# benchmark@1.9.1 still enables -pedantic-errors when BENCHMARK_ENABLE_WERROR=OFF;
# clang-22 promotes __COUNTER__ to -Wc2y-extensions, which pedantic-errors treats as fatal.
# This is clang-specific: MSVC (cl.exe) rejects -Wno-c2y-extensions with D8021 and has no
# such diagnostic, so only append it for the non-Windows (clang/gcc) toolchains.
# vcpkg_cmake_configure requires C/C++ flag vars to be set together.
if(NOT VCPKG_TARGET_IS_WINDOWS)
    string(APPEND VCPKG_CXX_FLAGS " -Wno-c2y-extensions")
    string(APPEND VCPKG_C_FLAGS " -Wno-c2y-extensions")
endif()

vcpkg_cmake_configure(
    SOURCE_PATH ${SOURCE_PATH}
    OPTIONS
        -DBENCHMARK_ENABLE_TESTING=OFF
        -DBENCHMARK_INSTALL_DOCS=OFF
        -Werror=old-style-cast
)

vcpkg_cmake_install()
vcpkg_copy_pdbs()

vcpkg_cmake_config_fixup(CONFIG_PATH lib/cmake/benchmark)

vcpkg_fixup_pkgconfig()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

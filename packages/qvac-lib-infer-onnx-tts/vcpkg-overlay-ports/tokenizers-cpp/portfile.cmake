vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO mlc-ai/tokenizers-cpp
    REF tags/v${VERSION}
    SHA512 e4c1a7a1f69482c4d923dbd91b1479c137dcc8f7ac8a2033f270eaf1f440d24c4f2e775a8fe4985f30cf30704de04c3102155990ce8588c76cafe4c0d33b345d
    PATCHES
        0001-build-only-hf-tokenizer.patch
        0002-fix-rust-build.patch
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
)

vcpkg_cmake_install()

vcpkg_cmake_config_fixup(
    PACKAGE_NAME tokenizers_cpp
    CONFIG_PATH lib/cmake/tokenizers_cpp
)

# Fix absolute build-tree paths in the generated CMake config.
# The Rust-built libtokenizers_c.a is linked by absolute build-tree path in
# the CMakeLists.txt. When CMake generates the export config, this absolute
# path is embedded directly. vcpkg_cmake_config_fixup only fixes paths
# referencing CURRENT_PACKAGES_DIR, not build-tree paths. We replace them
# with the correct installed location.
set(_RUST_LIB_UNIX [[${_IMPORT_PREFIX}/lib/libtokenizers_c.a]])
set(_RUST_LIB_WIN [[${_IMPORT_PREFIX}/lib/tokenizers_c.lib]])
file(GLOB _config_files "${CURRENT_PACKAGES_DIR}/share/tokenizers_cpp/*.cmake")
foreach(_f IN LISTS _config_files)
    file(READ "${_f}" _contents)
    set(_modified FALSE)
    if(_contents MATCHES "libtokenizers_c\\.a")
        string(REGEX REPLACE "/[^\";]*/libtokenizers_c\\.a" "${_RUST_LIB_UNIX}" _contents "${_contents}")
        set(_modified TRUE)
    endif()
    if(_contents MATCHES "tokenizers_c\\.lib")
        string(REGEX REPLACE "[A-Z]:/[^\";]*/tokenizers_c\\.lib" "${_RUST_LIB_WIN}" _contents "${_contents}")
        set(_modified TRUE)
    endif()
    if(_modified)
        file(WRITE "${_f}" "${_contents}")
    endif()
endforeach()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

file(INSTALL "${SOURCE_PATH}/LICENSE" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}" RENAME copyright)

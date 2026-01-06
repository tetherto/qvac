vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO rhasspy/piper-phonemize
    REF ba3cc06c5248215928821f1393b2b854a936991a
    SHA512 e125060736b966038dd09c744dc0808364eae092ee6d750d7e4af88d65d4d5fc29ee2c98507c2f762765a0ffd93cdfcb8269a52e1394f22a65e2d671b72be7a7
    HEAD_REF master
    PATCHES
        0001-use-vcpkg-deps.patch
        0002-use-static-build.patch
        0003-fix-windows-linking-espeak.patch
        0004-skip-ios-executable.patch
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DBUILD_SHARED_LIBS=OFF
        -DCMAKE_POSITION_INDEPENDENT_CODE=ON
)

vcpkg_cmake_install()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

file(INSTALL "${SOURCE_PATH}/LICENSE.md" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}" RENAME copyright) 
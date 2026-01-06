vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO rhasspy/piper
    REF 73c04d81d5590ecc46e522de3601ce7fb29fc2be
    SHA512 6f693f760c48575a68c6508ecade13a005f76575695ae348e8490b9e232c54e3240449d610ac60a8f9e90ed694bbc072c1abbcd671470a1d6701bb3c6b6798ab
    HEAD_REF master
    PATCHES
        0001-use-vcpkg-deps.patch
        0002-add-piper-core.patch
        0003-fix-android-build.patch
        0004-skip-ios-executable.patch
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
)

vcpkg_cmake_install()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

file(INSTALL "${SOURCE_PATH}/LICENSE.md" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}" RENAME copyright) 
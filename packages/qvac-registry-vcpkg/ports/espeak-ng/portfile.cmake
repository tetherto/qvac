vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO rhasspy/espeak-ng
    REF 0f65aa301e0d6bae5e172cc74197d32a6182200f
    SHA512 0fda32c8d4895310f8d2ce317f5d0fe58457b327fc9e648876d1dff9d37829120b58d9daa031f20d2c8df14560c76d44cee03cb094755f79ae21a973bd862c5d
    HEAD_REF master
    PATCHES
        0001-fix-sonic-fetchcontent.patch
        0002-fix-speechplayer-api.patch
        0003-fix-tests-not-available.patch
        0004-fix-compatibility-header.patch
        0005-remove-data-generation.patch
)

vcpkg_check_features(OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        async USE_ASYNC
        mbrola USE_MBROLA
        libsonic USE_LIBSONIC
        libpcaudio USE_LIBPCAUDIO
        klatt USE_KLATT
        speechplayer USE_SPEECHPLAYER
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DBUILD_SHARED_LIBS=OFF
        -DCMAKE_POSITION_INDEPENDENT_CODE=ON
        -DUSE_ASYNC=OFF
        -DUSE_MBROLA=OFF
        -DUSE_LIBSONIC=OFF
        -DUSE_LIBPCAUDIO=OFF
        -DUSE_KLATT=ON
        -DUSE_SPEECHPLAYER=ON
        ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()

# Install additional internal libraries that are built but not installed by default
if(VCPKG_TARGET_IS_WINDOWS)
    set(LIB_EXT ".lib")
    set(LIB_PREFIX "")
else()
    set(LIB_EXT ".a")
    set(LIB_PREFIX "lib")
endif()

file(INSTALL "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/src/ucd-tools/${LIB_PREFIX}ucd${LIB_EXT}" DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
file(INSTALL "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/src/speechPlayer/${LIB_PREFIX}speechPlayer${LIB_EXT}" DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
file(INSTALL "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-dbg/src/ucd-tools/${LIB_PREFIX}ucd${LIB_EXT}" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/lib")
file(INSTALL "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-dbg/src/speechPlayer/${LIB_PREFIX}speechPlayer${LIB_EXT}" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/lib")

# Install headers for internal libraries
file(INSTALL "${SOURCE_PATH}/src/ucd-tools/src/include/" DESTINATION "${CURRENT_PACKAGES_DIR}/include" FILES_MATCHING PATTERN "*.h")
file(INSTALL "${SOURCE_PATH}/src/speechPlayer/include/" DESTINATION "${CURRENT_PACKAGES_DIR}/include" FILES_MATCHING PATTERN "*.h")

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

file(INSTALL "${SOURCE_PATH}/COPYING" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}" RENAME copyright) 
# LOCAL OVERLAY PORT (QVAC-21921, dev-only)
#
# Builds audiogen-cpp from the local qvac-ext-lib-whisper.cpp/audiogen-cpp
# working tree (the ACE-Step music-generation engine split out of tts-cpp into
# its own engine folder) instead of a published registry pin, so the
# audiogen-ggml addon links the local engine. Drop this overlay once
# audiogen-cpp is merged and published to the registry.

set(SOURCE_PATH "$ENV{QVAC_AUDIOGEN_CPP_SRC}")
if(NOT SOURCE_PATH OR NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "audiogen-cpp overlay: set QVAC_AUDIOGEN_CPP_SRC to the audiogen-cpp checkout "
        "(got '${SOURCE_PATH}').")
endif()

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DAUDIOGEN_BUILD_LIBRARY=ON
        -DAUDIOGEN_BUILD_EXECUTABLES=OFF
        -DAUDIOGEN_BUILD_TESTS=OFF
        -DAUDIOGEN_INSTALL=ON
        -DAUDIOGEN_USE_SYSTEM_GGML=ON
        -DBUILD_SHARED_LIBS=OFF
        -DGGML_NATIVE=OFF
        -DGGML_OPENMP=OFF
        -DGGML_CCACHE=OFF
        -DAUDIOGEN_CCACHE=OFF
)

vcpkg_cmake_install()

vcpkg_cmake_config_fixup(PACKAGE_NAME audiogen-cpp CONFIG_PATH share/audiogen-cpp)

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

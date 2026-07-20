# stable-diffusion.cpp vcpkg OVERLAY port — TEMPORARY (ABot-World testing)
#
# This overlay pins the engine to the UNMERGED PR
#   tetherto/qvac-ext-stable-diffusion.cpp#22  (branch feature-abot-dit)
# so the diffusion addon can be built and GPU-tested against the ABot-World
# changes WITHOUT merging the sd.cpp PR or publishing a new registry port
# version (per the overlay-port workflow). It takes precedence over the
# `stable-diffusion-cpp` port in tetherto/qvac-registry-vcpkg.
#
# On merge of the sd.cpp PR + a registry port bump, delete this overlay and the
# `overlay-ports` entry in vcpkg-configuration.json, and bump the version in
# vcpkg.json instead.
#
# Body is a verbatim copy of the registry port (2026-07-03, port-version 5)
# with only REF + SHA512 changed to PR #22's head commit.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF da3f6b26d2c0575a0eb7592f13ea78fb0dd63425
    SHA512 c1cea11b590f988bf40cd484ad10e5bed75739d47ff5406766e53b24dd0e191786c10edf0d64928472a6b618063c0e22fc7d3918619eef3d15b007d2584a9320
)

set(SD_FLASH_ATTN OFF)

if("flash-attn" IN_LIST FEATURES)
    set(SD_FLASH_ATTN ON)
endif()

# Only build Release — debug builds are not needed for the prebuild and can
# fail with MSVC iterator-debug-level mismatches.
set(VCPKG_BUILD_TYPE release)

# --- Configure & build ---
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DSD_BUILD_EXAMPLES=OFF
        -DSD_BUILD_SHARED_LIBS=OFF
        -DSD_USE_SYSTEM_GGML=ON
        -DSD_FLASH_ATTN=${SD_FLASH_ATTN}
    MAYBE_UNUSED_VARIABLES
        SD_FLASH_ATTN
)

vcpkg_cmake_install()

# --- CMake package config ---
# Upstream does not export a CMake config, so we ship our own that defines
# stable-diffusion::stable-diffusion with ggml as a transitive dependency.
file(INSTALL
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfig.cmake"
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfigVersion.cmake"
    DESTINATION "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp"
)

# --- Cleanup ---
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

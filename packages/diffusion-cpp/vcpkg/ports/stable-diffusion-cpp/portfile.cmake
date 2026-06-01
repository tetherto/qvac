# stable-diffusion.cpp vcpkg overlay port (TEMPORARY)
#
# Points to the fix/wan-i2v-vae-tiling branch which adds the Wan 2.1 I2V
# VAE-tiling fix. This overlay is temporary and will be removed once the
# fix is merged upstream into the 2026-03-01 branch and published in the
# qvac registry.
#
# Cleanup checklist when upstream PR is merged:
#   1. delete this entire vcpkg/ports/ directory
#   2. drop the "overlay-ports" entry from vcpkg-configuration.json
#   3. bump stable-diffusion-cpp version>= in vcpkg.json to the new revision
#
# GitHub PR: https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/10
# Fix: Bypass spatial VAE tiling for Wan 2.1 I2V video encode/decode

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF c28ed2ab58ff849b1a09e1cd8ca6953fd6a7b418
    SHA512 d89ec481710b8b7a5505c55d8ce308e0ef1bcef024529a05bc646f36ade35511ced7abda1f6837de2b68f3c90bcb7aff20a3b6acfed0631833cdd212b4ac9889
    HEAD_REF 2026-03-01
    PATCHES
        wan-i2v-encode-video-bypass-tiling.patch
)

set(SD_FLASH_ATTN OFF)

if("flash-attn" IN_LIST FEATURES)
    set(SD_FLASH_ATTN ON)
endif()

# Only build Release -- debug builds are not needed for the prebuild and can
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

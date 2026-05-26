# stable-diffusion.cpp vcpkg overlay port (TEMPORARY)
#
# This overlay re-introduces the patch machinery that commit c11dfff7
# ("fix: consume stable diffusion overlay port") removed when the qvac
# registry took over publishing this port. Its sole purpose is to layer
# the Wan 2.1 I2V VAE-tiling fix from commit f7c97a8a on top of the same
# upstream tetherto/qvac-ext-stable-diffusion.cpp@9a0ca29 source the
# registry's `2026-03-01#4` revision targets.
#
# Remove this overlay once the patch has been merged upstream into the
# `2026-03-01` branch and a new port-revision is published in the qvac
# registry. Cleanup checklist:
#   1. delete this entire vcpkg/ports/ directory
#   2. drop the "overlay-ports" entry from vcpkg-configuration.json
#   3. bump stable-diffusion-cpp version>= in vcpkg.json to the new revision
#
# See: vcpkg/ports/stable-diffusion-cpp/wan-i2v-encode-video-bypass-tiling.patch
# for the upstream-bound fix; that file is the canonical source of truth for
# the change and should land verbatim in the upstream PR.

# Pinned to 00cd2a09 -- the same commit the qvac registry's
# stable-diffusion-cpp@2026-03-01#4 served (which is what `vcpkg.json`
# `version>=": "2026-03-01#4"` currently resolves to before the registry
# bumped to #5). Stays on #4 because the addon's SdModel.cpp references
# `SD_BACKEND_PREF_AUTO` which #4 exposes but #5 dropped from the public
# enum; bumping to a newer revision is a separate concern from the wan-i2v
# tiling fix.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 00cd2a099d984f9c484a0e9cdb5e096e94ec68d1
    SHA512 5be72e982fa970ebebe2cf6325ef73cde7a34ec1299018e8b16340e2cd6dccda8c65de04b408d294c84013683765c84be40c42790784cb3c77d3cdc7d79b4c0a
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

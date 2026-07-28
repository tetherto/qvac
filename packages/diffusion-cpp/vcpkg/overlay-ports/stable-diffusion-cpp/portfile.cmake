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
# Engine pinned to PR #22 head (adds native scene creation via
# sd_abot_scene_create - umT5-XXL prompt encode + Wan2.2 VAE first-frame
# encode - on top of the bounded-history/KV work, the Mac Metal KV-cache
# fixes, and the F32-params prefix fix).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 07cee515a29a609d9e9d615376ab56166783bfbf
    SHA512 2778a213439728db351b3a39e050e25480772dbe01b8900bab8cf9bb07544210abf4278ebc258956da046514d8f19925e076e303bd18e3df24d8f6a13145bc34
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

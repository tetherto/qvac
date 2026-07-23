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
    REF a98abc4678ad52ddd66be9ab221de0cf6a2b9097
    SHA512 955a563b975b0e8abaf0304b98b00b4ec8512bdc94d1716e22b05b1c1e7c0382d1ff4f0b463dc8cde4fc18d8a4a7ed7ce7ea6f251e6d48ef83d7754bd1b97eae
    PATCHES
        # RTX 5090 validation fixes, submitted to PR #22 (drop this patch and
        # bump REF once they land on feature-abot-dit):
        # - bounded-history walk graph (pin block 0 + trailing window) - fixes
        #   ~1.3 GiB/block VRAM growth that OOM'd a 32 GiB GPU at walk block 5
        # - opt-in per-layer KV cache (ABOT_KV_CACHE=1): 8.5 s -> 1.9 s/block
        # - taehv decode overlapped with the cache-append pass (second GPU via
        #   backend spec "diffusion=cuda0,vae=cuda1")
        # Parity 7/7 + golden-replay walk verified on both paths.
        abot-bounded-history.patch
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

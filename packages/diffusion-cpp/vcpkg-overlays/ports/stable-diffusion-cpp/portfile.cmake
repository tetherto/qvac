# stable-diffusion.cpp vcpkg overlay port (local dev: Ideogram 4 enablement)
#
# Builds the stable-diffusion.cpp inference library and links against the
# system-installed ggml (provided by the ggml port). GPU backend selection is
# handled at runtime via ggml's backend registry.
#
# Pulls from the tetherto/qvac-ext-stable-diffusion.cpp branch 2026-06-22
# (REF pinned to that branch's tip commit for reproducibility).
#
# 1b616b8 is the tip of 2026-06-22: the qvac patches (vcpkg port patches, ESRGAN
# upscaler device API, Wan 2.1 I2V VAE tiling fix, fused Flux RoPE, ggml public
# leaf-API migration, CLI GPU-default tweak, MSVC /bigobj) rebased cleanly onto
# leejet/master, which adds Ideogram 4 support (#1609) + circular RoPE (#1627)
# and the uncond_diffusion_model_path field needed for Ideogram CFG. The ggml
# git submodule has been removed; ggml is provided via SD_USE_SYSTEM_GGML from
# the vcpkg ggml port.
vcpkg_from_git(
    OUT_SOURCE_PATH SOURCE_PATH
    URL "https://github.com/tetherto/qvac-ext-stable-diffusion.cpp.git"
    REF c3bc14cdc154af8f39ad8094e39db8e50ef29e97
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

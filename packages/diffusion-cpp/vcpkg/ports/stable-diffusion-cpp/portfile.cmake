# stable-diffusion.cpp vcpkg overlay port
#
# Builds the stable-diffusion.cpp inference library and links against the
# system-installed ggml (provided by the separate ggml overlay port).
#
# Installed artefacts:
#   include/stable-diffusion.h   (main C API)
#   include/lam-a2e.h            (LAM audio2expression / ARKit-52 C API)
#   lib/libstable-diffusion.a    (static library; lam-a2e.cpp is glob-compiled
#                                 into the same target, see
#                                 qvac-ext-stable-diffusion.cpp CMakeLists.txt)
#   share/stable-diffusion-cpp/  (CMake package config)
#
# GPU backend selection is handled at runtime via ggml's backend registry.
# The downstream fork replaces SD's backend-specific init with
# ggml_backend_init_by_type() which works with both statically linked and
# dynamically loaded backends.
#
# Pulls from tetherto/qvac-ext-stable-diffusion.cpp, REF-pinned to an exact
# commit for reproducibility. Every REF below 6250dac was a 2026-07-03 branch
# tip; the current one is not (see the 7ea0187 note).
#
# This package-local overlay (packages/diffusion-cpp/vcpkg/ports/) tracks the
# port ahead of its next qvac-registry-vcpkg publish so diffusion-cpp can pick
# up LamAudio2Expression (packages/diffusion-cpp's sibling API to
# EsrganUpscaler) before the registry bump lands. Remove this overlay (and
# drop the "vcpkg/ports" entry from vcpkg-configuration.json) once the
# registry's stable-diffusion-cpp#6 (or later) is published.
#
# 7ea0187 adds the LAM audio2expression (ARKit-52 blendshape) engine:
# lam-a2e.h / lam-a2e.cpp / lam_audio2expression.cpp add a standalone
# lam_a2e_create/lam_a2e_process_pcm_f32/lam_a2e_free C API, CPU-only for now
# (use_gpu is accepted but not yet implemented upstream). No SD_LIB_SOURCES
# changes were needed beyond the new files themselves -- the library
# glob-includes every src/*.cpp automatically.
#
# TODO(QVAC-22248): re-pin before merge. Unlike every REF above it, 7ea0187 is
# NOT on 2026-07-03 -- it is the engine commit of the still-open PR #24
# (branch feat/QVAC-22248-lam-a2e, forked from 6250dac). GitHub serves an
# archive for it today, but a squash-merge plus branch delete would orphan the
# commit and break this download. Once PR #24 lands, re-point REF at the
# resulting 2026-07-03 tip and refresh SHA512.
#
# 6250dac is the tip of 2026-07-03 after merging PR #21: it fixes the Wan VAE
# temporal upsample to match the reference first-chunk "Rep" semantics (run
# time_conv with causal zero padding on chunk 0, trim the first doubled frame,
# seed the temporal feat cache), restoring decode parity with the PyTorch
# reference (cosine 1.000000 / 79 dB PSNR, was 0.9959 / 27 dB).
#
# 9f587ad is the tip of 2026-07-03 after merging PR #20 (Ideogram review
# fixes) on top of PR #19: it registers/applies optional Ideogram weight_scale
# tensors with the correct FP8 ordering (xW * weight_scale + b), stages only the
# active cond/uncond transformer params during non-segmented offload, and fails
# Ideogram generation when CFG is requested without a loaded unconditional model.
#
# f02a0b5 is the tip of 2026-07-03 after merging PR #19. It includes the
# 5832f9a size-reduction baseline plus Ideogram 4 support: Qwen3-VL
# conditioning, the Ideogram 4 runner, and
# sd_ctx_params_t::uncond_diffusion_model_path for loading the standalone
# unconditional CFG diffusion weights.
#
# fe394ca was the tip of 2026-07-03 — 2026-06-04-ltx (the merge of #13 into the
# 2026-06-04 base) plus one commit. The base carries the general qvac patches
# (vcpkg port patches, ESRGAN upscaler device API, Wan 2.1 I2V VAE tiling fix),
# while the merged -ltx delta adds fused Flux RoPE, the ggml public leaf-API
# migration, the CLI GPU-default tweak, the MSVC /bigobj fix for C1128, and
# exposes sd_ctx_params_t::backend for explicit backend pinning. The extra commit
# lets sd_resolve_backend_name() match a backend by its ggml registry name (e.g.
# "Vulkan0") in addition to device type.
#
# The vendored ggml submodule is kept on the -ltx branch for standalone
# (non-vcpkg) builds (SD_USE_SYSTEM_GGML defaults to OFF there), but this port
# builds with -DSD_USE_SYSTEM_GGML=ON so ggml is provided by the vcpkg ggml port
# (tetherto/qvac-ext-ggml@2026-07-03).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 7ea01875c76c4bfcf275a75038365abfb23eaa64
    SHA512 d59303fbaa5845e7bd6c3c52013befe5c941041845f78dfec8e4f0a225be32e5283676a6578a279e3cc35eb9305b7f37bbc3cc2caa8195f0efc0eabe431363b7
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

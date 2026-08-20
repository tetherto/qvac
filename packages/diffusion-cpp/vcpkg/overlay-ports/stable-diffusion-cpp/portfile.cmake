# stable-diffusion.cpp vcpkg overlay port
#
# Builds the stable-diffusion.cpp inference library and links against the
# system-installed ggml (provided by the separate ggml overlay port).
#
# Installed artefacts:
#   include/stable-diffusion.h   (main C API)
#   lib/libstable-diffusion.a    (static library)
#   share/stable-diffusion-cpp/  (CMake package config)
#
# GPU backend selection is handled at runtime via ggml's backend registry.
# The downstream fork replaces SD's backend-specific init with
# ggml_backend_init_by_type() which works with both statically linked and
# dynamically loaded backends.
#
# Pulls from the tetherto/qvac-ext-stable-diffusion.cpp GitHub branch
# 2026-07-03 (REF pinned to the branch tip for reproducibility).
#
# 1dcbe360 is the merged 2026-07-03 tip after merging qvac-ext-stable-
# diffusion.cpp PR #25, preserving the ABot-World session API while adding
# the final transactional LoRA loading and safe VAE fallback fixes.
#
# 97594f3 is the tip of 2026-07-03 after merging PR #27 on top of PR #22:
# the walk's masked self-attention composes its mask explicitly
# (scale -> add -> soft_max, the KV-cache path's formulation) instead of the
# fused masked soft-max, whose CUDA kernel in this line's ggml (50cf5630)
# rejects the walk's 2D-mask head broadcast. Golden-replay gated at cosines
# identical to the fused path; the former CUDA crash config now passes.
#
# 61235ea is the tip of 2026-07-03 after merging PR #22: full ABot-World
# support — model detection/loading, the interactive walk session C API
# (sd_abot_session_*, opt-in per-layer KV cache + profiling as session
# params, validated against the attention window at load), native scene
# creation (sd_abot_scene_create: umT5-XXL prompt encode + Wan2.2 VAE
# first-frame encode, replacing offline PyTorch extraction), gated text-only
# packs, an untrusted-input-hardened scene-pack parser behind an exception
# barrier at the C API boundary, and a fix that loads DiT params in their
# GGUF type (quantized DiTs run natively; halves weight VRAM). Existing
# pipelines are untouched (additive-only vs 6250dac; see the PR's regression
# notes — the full SD/SDXL/FLUX.2/Wan/LTX/Ideogram/ESRGAN suite is green on
# this build). Runs on this line's ggml (2026-07-03#2) unmodified: the walk's
# masked attention composes its mask explicitly (scale -> add -> soft_max)
# instead of relying on the fused masked soft-max kernel.
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
    REF 1dcbe3604c195a18005e95d9b7fd467c316643cc
    SHA512 e578efc65e398c7712ee674243f25b960e9bb04d96d3bee0860623a958d2016575e6df42983365b798014940bc50cdf08cdee09736cee2bd910ac4f52ab3caa8
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

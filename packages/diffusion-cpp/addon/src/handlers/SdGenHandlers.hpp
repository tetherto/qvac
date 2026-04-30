#pragma once

#include <functional>
#include <string>
#include <unordered_map>

#include <picojson/picojson.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <stable-diffusion.h>

namespace qvac_lib_inference_addon_sd {

/**
 * All per-job generation parameters for a single txt2img or img2img call.
 *
 * Populated by applySdGenHandlers() inside SdModel::process(), then mapped
 * to sd_img_gen_params_t before generate_image() is called.
 *
 * txt2vid (video) is intentionally unsupported.
 */
struct SdGenConfig {

  // -- Mode ------------------------------------------------------------------
  std::string mode = "txt2img"; // "txt2img" (default) or "img2img"

  // -- Prompt ----------------------------------------------------------------
  std::string prompt;
  std::string negativePrompt;
  std::string loraPath;

  // -- Image dimensions -----------------------------------------------------
  int width = 512; // must be a positive multiple of 8
  int height = 512;

  // -- Sampling --------------------------------------------------------------
  // SAMPLE_METHOD_COUNT / SCHEDULER_COUNT = "auto" -- stable-diffusion.cpp
  // selects the correct default for each model family at runtime:
  //   DiT / FLUX -> euler + karras   SD1/SD2 -> euler_a + discrete
  int steps = 20;
  sample_method_t sampleMethod = SAMPLE_METHOD_COUNT; // auto
  scheduler_t scheduler = SCHEDULER_COUNT;            // auto
  float eta = 0.0f; // stochasticity for DDIM / TCD samplers

  // -- Guidance -------------------------------------------------------------
  float cfgScale =
      7.0f; // txt_cfg  -- CFG (Classifier-Free Guidance) for SD1/SD2
  float guidance = 3.5f; // distilled_guidance -- FLUX.2 flow-matching scale
  float imgCfgScale =
      -1.0f; // img_cfg  -- image guidance for img2img/inpaint; -1 = cfgScale

  // -- Reproducibility -------------------------------------------------------
  int64_t seed = -1; // -1 = random

  // -- Batching --------------------------------------------------------------
  int batchCount = 1;

  // -- img2img / inpaint -----------------------------------------------------
  float strength = 0.75f; // denoising strength: 0 = keep init, 1 = ignore it
  int clipSkip =
      -1; // skip last N CLIP encoder layers (SD1.x / SD2.x); -1 = auto

  // -- Multi-reference (FLUX/FLUX2 "fusion") --------------------------------
  // Maps to sd_img_gen_params_t.increase_ref_index. This default matches the
  // upstream library / sd-cli default (false).
  //
  // How it actually behaves (see stable-diffusion.cpp/src/rope.hpp ::
  // gen_refs_ids):
  //   false -> all reference latents share the same RoPE index slot and tile
  //           into the same image coordinate space as the target. Attention
  //           blends their features -> this is what produces visible visual
  //           "fusion" on FLUX / FLUX2-klein. CLI default. Recommended.
  //   true  -> each reference gets its own incrementing index. The model
  //           treats refs as independent samples in separate slots. For
  //           models whose text encoder understands "Picture N:" / vision
  //           tokens (Qwen-Image-Edit, Z-Image-Omni) this is what lets
  //           @imageN in the prompt bind to a specific ref. For FLUX2-klein
  //           (whose Qwen3 text encoder has no vision tokens for refs) this
  //           usually just makes one ref dominate and suppresses fusion.
  //
  // Callers can override per-job by setting `increase_ref_index: true/false`.
  //
  // autoResizeRefImage maps to sd_img_gen_params_t.auto_resize_ref_image --
  // on by default; disable only if you have pre-resized every reference.
  bool increaseRefIndex = false;
  bool autoResizeRefImage = true;

  // -- VAE tiling -- required for images > ~768px on 16 GB machines ----------
  // Maps to sd_img_gen_params_t.vae_tiling_params
  bool vaeTiling = false;
  int vaeTileSizeX = 512;      // tile width  in pixels
  int vaeTileSizeY = 512;      // tile height in pixels
  float vaeTileOverlap = 0.5f; // fraction of tile used as overlap seam (0-1)

  // -- Step-caching (cuts FLUX generation time by 30-50%) -------------------
  // Maps to sd_img_gen_params_t.cache
  // cache_mode: "disabled", "easycache" (DiT), "ucache" (UNet), "dbcache",
  //             "taylorseer", "cache-dit"
  // cache_preset: "slow", "medium", "fast", "ultra" (shorthand for threshold)
  // cache_threshold: direct override for reuse_threshold (0 = library default)
  sd_cache_mode_t cacheMode = SD_CACHE_DISABLED;
  float cacheThreshold = 0.0f; // reuse_threshold; 0 = use library default
  float cacheStart = 0.0f;     // start_percent;   0 = use library default
  float cacheEnd = 0.0f;       // end_percent;     0 = use library default
};

// -----------------------------------------------------------------------------

/**
 * Handler function for a single per-job JSON key.
 * Receives the config struct (by ref) and the raw picojson::value.
 * Throws qvac_errors::StatusError on invalid input.
 */
using SdGenHandlerFn =
    std::function<void(SdGenConfig&, const picojson::value&)>;
using SdGenHandlersMap = std::unordered_map<std::string, SdGenHandlerFn>;

/** All supported per-job generation param keys and their handlers. */
extern const SdGenHandlersMap SD_GEN_HANDLERS;

/**
 * Apply SD_GEN_HANDLERS to a parsed JSON params object, writing into config.
 * Unknown keys are silently ignored (forward compatibility).
 */
void applySdGenHandlers(SdGenConfig& config, const picojson::object& obj);

} // namespace qvac_lib_inference_addon_sd

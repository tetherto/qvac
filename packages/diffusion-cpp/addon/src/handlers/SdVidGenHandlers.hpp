#pragma once

#include <functional>
#include <string>
#include <unordered_map>

#include <inference-addon-cpp/Errors.hpp>
#include <picojson/picojson.h>
#include <stable-diffusion.h>

namespace qvac_lib_inference_addon_sd {

/**
 * All per-job generation parameters for a single video generation call
 * (txt2vid / img2vid / flf2vid). Populated by applySdVidGenHandlers() inside
 * SdModel::process(), then mapped to sd_vid_gen_params_t before
 * generate_video() is called.
 *
 * Wan 2.1 uses a single expert -- map diffusionModelPath at context load,
 *   leave highNoiseDiffusionModelPath empty, use the low-noise sample params
 *   (fields without the highNoise prefix).
 * Wan 2.2 has a MoE pair -- map diffusionModelPath = low-noise expert and
 *   highNoiseDiffusionModelPath = high-noise expert, set moeBoundary, and
 *   configure highNoise* sample params.
 */
struct SdVidGenConfig {

  // -- Mode ------------------------------------------------------------------
  // "txt2vid" (default)  -- prompt-only, no init or end image
  // "img2vid"            -- animate a single init image (strength controls
  //                         how much denoise deviates from init)
  // "flf2vid"            -- interpolate between first (init) and last (end)
  //                         frame; both images required
  std::string mode = "txt2vid";

  // -- Prompt ----------------------------------------------------------------
  std::string prompt;
  std::string negativePrompt;

  // -- Video dimensions ------------------------------------------------------
  // Default 480 x 832 (portrait, phone-screen friendly). Wan 2.1 T2V 1.3B is
  // trained on 832 x 480 landscape; the model handles both orientations
  // equally well, so we default to portrait for mobile-first display.
  // Override via params.width / params.height. Must be multiples of 8.
  int width = 480;
  int height = 832;

  // -- Frame count -----------------------------------------------------------
  // Wan latent temporal packing requires (4 * k + 1) total frames where
  // k >= 1. Validated in the handler; default 33 == ~2 s at the default
  // fps of 16 (33 / 16 ~= 2.06 s).
  int videoFrames = 33;

  // -- Frames per second ----------------------------------------------------
  // Not part of sd_vid_gen_params_t -- consumed only by the addon's AVI
  // muxer when emitting the final video. Upstream generate_video() treats
  // frames as a pure sequence; fps is presentational metadata.
  int fps = 16;

  // -- Reproducibility -------------------------------------------------------
  int64_t seed = -1; // -1 = random

  // -- Low-noise expert (only expert on Wan 2.1) ----------------------------
  // Mapped to sd_vid_gen_params_t::sample_params.
  int sampleSteps = 30;
  sample_method_t sampleMethod = EULER_SAMPLE_METHOD; // Wan recommended
  scheduler_t scheduler = SIMPLE_SCHEDULER;           // Wan recommended
  float cfgScale = 6.0f;                              // guidance.txt_cfg
  // Flow-matching noise schedule shift. Convention:
  //   - 0.0f (default sentinel): fall through to SdCtxConfig::flowShift,
  //     which itself defaults to infinity (model-embedded value).
  //   - > 0.0f: per-job override.
  // Wan T2V 1.3B sweet spot: 3.0. Higher values (5+) compress the
  // rectified-flow trajectory and can produce visibly "frozen" video
  // (consecutive frames near-identical); some upstream docs misleadingly
  // mention 5-8 -- see examples/generate-video-wan.js for the rationale.
  // To literally disable flow-shifting, set the ctx-level flow_shift,
  // not this one (0.0f here is reserved as the fall-through sentinel).
  float flowShift = 0.0f;

  // -- High-noise expert (Wan 2.2 only) -------------------------------------
  // Mapped to sd_vid_gen_params_t::high_noise_sample_params. Ignored at
  // runtime unless SdCtxConfig::highNoiseDiffusionModelPath is also set.
  int highNoiseSteps = 30;
  sample_method_t highNoiseSampleMethod = EULER_SAMPLE_METHOD;
  scheduler_t highNoiseScheduler = SIMPLE_SCHEDULER;
  float highNoiseCfgScale = 6.0f;
  float highNoiseFlowShift = 0.0f;

  // Boundary between low-noise and high-noise expert trajectories, in the
  // normalized diffusion timestep. Wan 2.2 sweet spot ~0.875. Clamped to
  // [0, 1] by the handler. Ignored when highNoiseDiffusionModelPath is
  // empty (Wan 2.1).
  float moeBoundary = 0.875f;

  // -- Denoising strength (img2vid / flf2vid) -------------------------------
  // 0 = keep init, 1 = ignore it. Ignored for txt2vid.
  float strength = 0.75f;

  // -- VACE strength (controlled video generation) --------------------------
  // Controls how strongly control_frames influence the output. 1.0 = full
  // control influence, 0.0 = ignore control frames entirely. Only used
  // when control_frames are supplied on the GenerationJob.
  float vaceStrength = 1.0f;

  // -- VAE tiling -- strongly recommended ON for Wan (VAE peaks ~4-6 GB
  //                  at 832x480 / 480x832 without tiling). Mapped to
  //                  sd_vid_gen_params_t::vae_tiling_params.
  bool vaeTiling = true;
  int vaeTileSizeX = 512;      // tile width  in pixels
  int vaeTileSizeY = 512;      // tile height in pixels
  float vaeTileOverlap = 0.5f; // fraction of tile used as overlap seam (0-1)

  // -- Step-caching ----------------------------------------------------------
  // Mapped to sd_vid_gen_params_t::cache. Same enum as image generation.
  // Wan benefits from caching similarly to FLUX: 20-40% speed-up depending
  // on preset.
  sd_cache_mode_t cacheMode = SD_CACHE_DISABLED;
  float cacheThreshold = 0.0f; // 0 = library default
};

// -----------------------------------------------------------------------------

/**
 * Handler function for a single per-job JSON key.
 * Receives the config struct (by ref) and the raw picojson::value.
 * Throws qvac_errors::StatusError on invalid input.
 */
using SdVidGenHandlerFn =
    std::function<void(SdVidGenConfig &, const picojson::value &)>;
using SdVidGenHandlersMap = std::unordered_map<std::string, SdVidGenHandlerFn>;

/** All supported per-job video generation param keys and their handlers. */
extern const SdVidGenHandlersMap SD_VID_GEN_HANDLERS;

/**
 * Apply SD_VID_GEN_HANDLERS to a parsed JSON params object, writing into
 * config. Unknown keys are silently ignored (forward compatibility).
 */
void applySdVidGenHandlers(SdVidGenConfig &config, const picojson::object &obj);

} // namespace qvac_lib_inference_addon_sd

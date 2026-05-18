#include "SdGenHandlers.hpp"

#include <limits>
#include <unordered_map>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>

#include "SdParsers.hpp"

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;
using parsers::parseCacheMode;
using parsers::parseCachePreset;
using parsers::parseSampler;
using parsers::parseScheduler;
using parsers::parseVaeTileSize;
using parsers::requireBool;
using parsers::requireFiniteFloat;
using parsers::requireFiniteFloatInRange;
using parsers::requireInt;
using parsers::requireInt64;
using parsers::requireNum;
using parsers::requireStr;

// -- Local image-gen helpers --------------------------------------------------

static int parseUpscaleRepeats(const picojson::value &v) {
  // requireInt rejects NaN / inf / fractional / out-of-int-range; we only
  // need to add the `>= 1` policy here. (The previous implementation used
  // raw requireNum -- NaN sneaks past `raw < 1.0 || raw > MAX` because both
  // comparisons are false for NaN, and the static_cast<int>(NaN) is then
  // undefined behaviour.) No policy cap: repeated x4 upscales are memory-
  // bound, so the int range check inside requireInt is enough.
  const int repeats = requireInt(v, "upscale.repeats");
  if (repeats < 1) {
    throw StatusError(general_error::InvalidArgument,
                      "upscale.repeats must be a positive integer");
  }
  return repeats;
}

// -- Handler map
// ---------------------------------------------------------------

const SdGenHandlersMap SD_GEN_HANDLERS = {

    // -- Mode
    // --------------------------------------------------------------------

    {"mode",
     [](SdGenConfig &c, const picojson::value &v) {
       const auto mode = requireStr(v, "mode");
       if (mode != "txt2img" && mode != "img2img")
         throw StatusError(general_error::InvalidArgument,
                           "mode must be 'txt2img' or 'img2img', got: '" +
                               mode + "'");
       c.mode = mode;
     }},

    // -- Prompt
    // ------------------------------------------------------------------

    {"prompt",
     [](SdGenConfig &c, const picojson::value &v) {
       c.prompt = requireStr(v, "prompt");
     }},
    {"negative_prompt",
     [](SdGenConfig &c, const picojson::value &v) {
       c.negativePrompt = requireStr(v, "negative_prompt");
     }},
    {"lora",
     [](SdGenConfig &c, const picojson::value &v) {
       c.loraPath = requireStr(v, "lora");
     }},

    // -- Image dimensions
    // --------------------------------------------------------

    {"width",
     [](SdGenConfig &c, const picojson::value &v) {
       const int w = requireInt(v, "width");
       if (w <= 0 || w % 8 != 0)
         throw StatusError(general_error::InvalidArgument,
                           "width must be a positive multiple of 8, got: " +
                               std::to_string(w));
       c.width = w;
     }},

    {"height",
     [](SdGenConfig &c, const picojson::value &v) {
       const int h = requireInt(v, "height");
       if (h <= 0 || h % 8 != 0)
         throw StatusError(general_error::InvalidArgument,
                           "height must be a positive multiple of 8, got: " +
                               std::to_string(h));
       c.height = h;
     }},

    // -- Sampling
    // ----------------------------------------------------------------

    {"steps",
     [](SdGenConfig &c, const picojson::value &v) {
       const int s = requireInt(v, "steps");
       if (s <= 0)
         throw StatusError(general_error::InvalidArgument, "steps must be > 0");
       c.steps = s;
     }},

    // Both "sampling_method" and "sampler" are accepted.
    {"sampling_method",
     [](SdGenConfig &c, const picojson::value &v) {
       c.sampleMethod = parseSampler(requireStr(v, "sampling_method"));
     }},
    {"sampler",
     [](SdGenConfig &c, const picojson::value &v) {
       c.sampleMethod = parseSampler(requireStr(v, "sampler"));
     }},

    {"scheduler",
     [](SdGenConfig &c, const picojson::value &v) {
       c.scheduler = parseScheduler(requireStr(v, "scheduler"));
     }},

    {"eta",
     [](SdGenConfig &c, const picojson::value &v) {
       c.eta = requireFiniteFloat(v, "eta");
     }},

    // -- Guidance
    // ----------------------------------------------------------------

    {"cfg_scale",
     [](SdGenConfig &c, const picojson::value &v) {
       c.cfgScale = requireFiniteFloat(v, "cfg_scale");
     }},

    // distilled_guidance -- FLUX.2 specific; separate from cfg_scale.
    // Default 3.5 is the FLUX recommendation. Too low = washed out, too high =
    // over-saturated.
    {"guidance",
     [](SdGenConfig &c, const picojson::value &v) {
       c.guidance = requireFiniteFloat(v, "guidance");
     }},

    // img_cfg -- image guidance for img2img / inpaint workflows; -1 = use
    // cfg_scale.
    {"img_cfg_scale",
     [](SdGenConfig &c, const picojson::value &v) {
       c.imgCfgScale = requireFiniteFloat(v, "img_cfg_scale");
     }},

    // -- Reproducibility
    // ---------------------------------------------------------

    {"seed",
     [](SdGenConfig &c, const picojson::value &v) {
       c.seed = requireInt64(v, "seed");
     }},

    // -- Batching
    // ----------------------------------------------------------------

    {"batch_count",
     [](SdGenConfig &c, const picojson::value &v) {
       const int b = requireInt(v, "batch_count");
       if (b <= 0)
         throw StatusError(general_error::InvalidArgument,
                           "batch_count must be > 0");
       c.batchCount = b;
     }},

    // -- img2img
    // -----------------------------------------------------------------

    {"strength",
     [](SdGenConfig &c, const picojson::value &v) {
       c.strength = requireFiniteFloatInRange(v, "strength", 0.0f, 1.0f);
     }},

    // clip_skip -- skip last N CLIP layers. Used by SD2.x fine-tunes.
    // -1 = auto (SD2 default is 2). Ignored for FLUX.
    {"clip_skip",
     [](SdGenConfig &c, const picojson::value &v) {
       c.clipSkip = requireInt(v, "clip_skip");
     }},

    // -- VAE tiling
    // --------------------------------------------------------------

    {"vae_tiling",
     [](SdGenConfig &c, const picojson::value &v) {
       c.vaeTiling = requireBool(v, "vae_tiling");
     }},

    // -- Multi-reference (FLUX/FLUX2 fusion) ------------------------------
    //
    // increase_ref_index: when false (default) every ref shares one RoPE
    //   slot and the references blend visually via attention — recommended
    //   for FLUX.2-klein. When true each ref gets its own RoPE index — use
    //   with models whose text encoder receives per-image vision tokens
    //   (e.g. Qwen-Image-Edit, Z-Image-Omni). See
    //   SdGenConfig::increaseRefIndex.
    //
    // auto_resize_ref_image: when true (default), each ref image is resized to
    //   the target width/height before being VAE-encoded.
    {"increase_ref_index",
     [](SdGenConfig &c, const picojson::value &v) {
       c.increaseRefIndex = requireBool(v, "increase_ref_index");
     }},

    {"auto_resize_ref_image",
     [](SdGenConfig &c, const picojson::value &v) {
       c.autoResizeRefImage = requireBool(v, "auto_resize_ref_image");
     }},

    // vae_tile_size accepts either an integer (applied to both axes) or "WxH"
    // string.
    {"vae_tile_size",
     [](SdGenConfig &c, const picojson::value &v) {
       auto [w, h] = parseVaeTileSize(v);
       c.vaeTileSizeX = w;
       c.vaeTileSizeY = h;
     }},

    {"vae_tile_overlap",
     [](SdGenConfig &c, const picojson::value &v) {
       // Half-open [0, 1) -- see SdVidGenHandlers for the NaN-sneak-past
       // rationale; the finite guard runs before the upper-bound check here
       // too.
       const float overlap = requireFiniteFloat(v, "vae_tile_overlap");
       if (overlap < 0.0f || overlap >= 1.0f)
         throw StatusError(general_error::InvalidArgument,
                           "vae_tile_overlap must be in [0, 1), got: " +
                               std::to_string(overlap));
       c.vaeTileOverlap = overlap;
     }},

    // -- Step-caching
    // ------------------------------------------------------------
    // cache_mode selects the algorithm. cache_preset is a convenience shorthand
    // that sets both the mode and sensible threshold defaults.

    {"cache_mode",
     [](SdGenConfig &c, const picojson::value &v) {
       c.cacheMode = parseCacheMode(requireStr(v, "cache_mode"));
     }},

    // cache_preset -- shorthand for "easycache + threshold".
    {"cache_preset",
     [](SdGenConfig &c, const picojson::value &v) {
       auto [mode, threshold] = parseCachePreset(requireStr(v, "cache_preset"));
       c.cacheMode = mode;
       c.cacheThreshold = threshold;
     }},

    // cache_threshold -- direct override for reuse_threshold; 0 = library
    // default.
    {"cache_threshold",
     [](SdGenConfig &c, const picojson::value &v) {
       c.cacheThreshold = requireFiniteFloat(v, "cache_threshold");
     }},

    // ── Post-generation ESRGAN upscale
    // ──────────────────────────────────────

    {"upscale",
     [](SdGenConfig &c, const picojson::value &v) {
       if (v.is<bool>()) {
         c.upscale = v.get<bool>();
         c.upscaleRepeats = 1;
         return;
       }

       if (!v.is<picojson::object>()) {
         throw StatusError(general_error::InvalidArgument,
                           "upscale must be a boolean or an object");
       }

       c.upscale = true;
       c.upscaleRepeats = 1;

       const auto &obj = v.get<picojson::object>();
       if (auto it = obj.find("repeats"); it != obj.end()) {
         c.upscaleRepeats = parseUpscaleRepeats(it->second);
       }
     }},

};

// -----------------------------------------------------------------------------

void applySdGenHandlers(SdGenConfig &config, const picojson::object &obj) {
  for (const auto &[key, value] : obj) {
    if (auto it = SD_GEN_HANDLERS.find(key); it != SD_GEN_HANDLERS.end()) {
      it->second(config, value);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

} // namespace qvac_lib_inference_addon_sd

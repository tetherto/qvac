#include "SdGenHandlers.hpp"

#include <limits>
#include <unordered_map>
#include <utility>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "SdParsers.hpp"

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;
using parsers::parseCacheMode;
using parsers::parseCachePreset;
using parsers::parseSampler;
using parsers::parseScheduler;
using parsers::parseVaeTileSize;
using parsers::requireBool;
using parsers::requireNum;
using parsers::requireStr;

// -- Local image-gen helpers --------------------------------------------------

static int parseUpscaleRepeats(const picojson::value& v) {
  const double raw = requireNum(v, "upscale.repeats");
  // No policy cap: repeated x4 upscales are memory-bound, so only guard the
  // native int storage used for the loop count.
  if (raw < 1.0 || raw > static_cast<double>(std::numeric_limits<int>::max())) {
    throw StatusError(
        general_error::InvalidArgument,
        "upscale.repeats must be a positive integer");
  }

  const int repeats = static_cast<int>(raw);
  if (raw != static_cast<double>(repeats)) {
    throw StatusError(
        general_error::InvalidArgument,
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
     [](SdGenConfig& c, const picojson::value& v) {
       const auto mode = requireStr(v, "mode");
       if (mode != "txt2img" && mode != "img2img")
         throw StatusError(
             general_error::InvalidArgument,
             "mode must be 'txt2img' or 'img2img', got: '" + mode + "'");
       c.mode = mode;
     }},

    // -- Prompt
    // ------------------------------------------------------------------

    {"prompt",
     [](SdGenConfig& c, const picojson::value& v) {
       c.prompt = requireStr(v, "prompt");
     }},
    {"negative_prompt",
     [](SdGenConfig& c, const picojson::value& v) {
       c.negativePrompt = requireStr(v, "negative_prompt");
     }},
    {"lora",
     [](SdGenConfig& c, const picojson::value& v) {
       c.loraPath = requireStr(v, "lora");
     }},

    // -- Image dimensions
    // --------------------------------------------------------

    {"width",
     [](SdGenConfig& c, const picojson::value& v) {
       int w = static_cast<int>(requireNum(v, "width"));
       if (w <= 0 || w % 8 != 0)
         throw StatusError(
             general_error::InvalidArgument,
             "width must be a positive multiple of 8, got: " +
                 std::to_string(w));
       c.width = w;
     }},

    {"height",
     [](SdGenConfig& c, const picojson::value& v) {
       int h = static_cast<int>(requireNum(v, "height"));
       if (h <= 0 || h % 8 != 0)
         throw StatusError(
             general_error::InvalidArgument,
             "height must be a positive multiple of 8, got: " +
                 std::to_string(h));
       c.height = h;
     }},

    // -- Sampling
    // ----------------------------------------------------------------

    {"steps",
     [](SdGenConfig& c, const picojson::value& v) {
       int s = static_cast<int>(requireNum(v, "steps"));
       if (s <= 0)
         throw StatusError(general_error::InvalidArgument, "steps must be > 0");
       c.steps = s;
     }},

    // Both "sampling_method" and "sampler" are accepted.
    {"sampling_method",
     [](SdGenConfig& c, const picojson::value& v) {
       c.sampleMethod = parseSampler(requireStr(v, "sampling_method"));
     }},
    {"sampler",
     [](SdGenConfig& c, const picojson::value& v) {
       c.sampleMethod = parseSampler(requireStr(v, "sampler"));
     }},

    {"scheduler",
     [](SdGenConfig& c, const picojson::value& v) {
       c.scheduler = parseScheduler(requireStr(v, "scheduler"));
     }},

    {"eta",
     [](SdGenConfig& c, const picojson::value& v) {
       c.eta = static_cast<float>(requireNum(v, "eta"));
     }},

    // -- Guidance
    // ----------------------------------------------------------------

    {"cfg_scale",
     [](SdGenConfig& c, const picojson::value& v) {
       c.cfgScale = static_cast<float>(requireNum(v, "cfg_scale"));
     }},

    // distilled_guidance -- FLUX.2 specific; separate from cfg_scale.
    // Default 3.5 is the FLUX recommendation. Too low = washed out, too high =
    // over-saturated.
    {"guidance",
     [](SdGenConfig& c, const picojson::value& v) {
       c.guidance = static_cast<float>(requireNum(v, "guidance"));
     }},

    // img_cfg -- image guidance for img2img / inpaint workflows; -1 = use
    // cfg_scale.
    {"img_cfg_scale",
     [](SdGenConfig& c, const picojson::value& v) {
       c.imgCfgScale = static_cast<float>(requireNum(v, "img_cfg_scale"));
     }},

    // -- Reproducibility
    // ---------------------------------------------------------

    {"seed",
     [](SdGenConfig& c, const picojson::value& v) {
       c.seed = static_cast<int64_t>(requireNum(v, "seed"));
     }},

    // -- Batching
    // ----------------------------------------------------------------

    {"batch_count",
     [](SdGenConfig& c, const picojson::value& v) {
       int b = static_cast<int>(requireNum(v, "batch_count"));
       if (b <= 0)
         throw StatusError(
             general_error::InvalidArgument, "batch_count must be > 0");
       c.batchCount = b;
     }},

    // -- img2img
    // -----------------------------------------------------------------

    {"strength",
     [](SdGenConfig& c, const picojson::value& v) {
       float s = static_cast<float>(requireNum(v, "strength"));
       if (s < 0.0f || s > 1.0f)
         throw StatusError(
             general_error::InvalidArgument,
             "strength must be in [0, 1], got: " + std::to_string(s));
       c.strength = s;
     }},

    // clip_skip -- skip last N CLIP layers. Used by SD1.x / SD2.x fine-tunes.
    // -1 = auto (1 for SD1, 2 for SD2). Ignored for FLUX.
    {"clip_skip",
     [](SdGenConfig& c, const picojson::value& v) {
       c.clipSkip = static_cast<int>(requireNum(v, "clip_skip"));
     }},

    // -- VAE tiling
    // --------------------------------------------------------------

    {"vae_tiling",
     [](SdGenConfig& c, const picojson::value& v) {
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
     [](SdGenConfig& c, const picojson::value& v) {
       c.increaseRefIndex = requireBool(v, "increase_ref_index");
     }},

    {"auto_resize_ref_image",
     [](SdGenConfig& c, const picojson::value& v) {
       c.autoResizeRefImage = requireBool(v, "auto_resize_ref_image");
     }},

    // vae_tile_size accepts either an integer (applied to both axes) or "WxH"
    // string.
    {"vae_tile_size",
     [](SdGenConfig& c, const picojson::value& v) {
       auto [w, h] = parseVaeTileSize(v);
       c.vaeTileSizeX = w;
       c.vaeTileSizeY = h;
     }},

    {"vae_tile_overlap",
     [](SdGenConfig& c, const picojson::value& v) {
       float overlap = static_cast<float>(requireNum(v, "vae_tile_overlap"));
       if (overlap < 0.0f || overlap >= 1.0f)
         throw StatusError(
             general_error::InvalidArgument,
             "vae_tile_overlap must be in [0, 1), got: " +
                 std::to_string(overlap));
       c.vaeTileOverlap = overlap;
     }},

    // -- Step-caching
    // ------------------------------------------------------------
    // cache_mode selects the algorithm. cache_preset is a convenience shorthand
    // that sets both the mode and sensible threshold defaults.

    {"cache_mode",
     [](SdGenConfig& c, const picojson::value& v) {
       c.cacheMode = parseCacheMode(requireStr(v, "cache_mode"));
     }},

    // cache_preset -- shorthand for "easycache + threshold".
    {"cache_preset",
     [](SdGenConfig& c, const picojson::value& v) {
       auto [mode, threshold] = parseCachePreset(requireStr(v, "cache_preset"));
       c.cacheMode = mode;
       c.cacheThreshold = threshold;
     }},

    // cache_threshold -- direct override for reuse_threshold; 0 = library
    // default.
    {"cache_threshold",
     [](SdGenConfig& c, const picojson::value& v) {
       c.cacheThreshold = static_cast<float>(requireNum(v, "cache_threshold"));
     }},

    // ── Post-generation ESRGAN upscale
    // ──────────────────────────────────────

    {"upscale",
     [](SdGenConfig& c, const picojson::value& v) {
       if (v.is<bool>()) {
         c.upscale = v.get<bool>();
         c.upscaleRepeats = 1;
         return;
       }

       if (!v.is<picojson::object>()) {
         throw StatusError(
             general_error::InvalidArgument,
             "upscale must be a boolean or an object");
       }

       c.upscale = true;
       c.upscaleRepeats = 1;

       const auto& obj = v.get<picojson::object>();
       if (auto it = obj.find("repeats"); it != obj.end()) {
         c.upscaleRepeats = parseUpscaleRepeats(it->second);
       }
     }},

};

// -----------------------------------------------------------------------------

void applySdGenHandlers(SdGenConfig& config, const picojson::object& obj) {
  for (const auto& [key, value] : obj) {
    if (auto it = SD_GEN_HANDLERS.find(key); it != SD_GEN_HANDLERS.end()) {
      it->second(config, value);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

} // namespace qvac_lib_inference_addon_sd

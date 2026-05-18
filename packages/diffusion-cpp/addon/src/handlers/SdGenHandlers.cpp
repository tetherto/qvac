#include "SdGenHandlers.hpp"

#include <charconv>
#include <limits>
#include <string_view>
#include <unordered_map>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;

// -- JSON value helpers
// --------------------------------------------------------

static double requireNum(const picojson::value& val, const std::string& key) {
  if (!val.is<double>()) {
    throw StatusError(
        general_error::InvalidArgument, key + " must be a number");
  }
  return val.get<double>();
}

static std::string
requireStr(const picojson::value& val, const std::string& key) {
  if (!val.is<std::string>()) {
    throw StatusError(
        general_error::InvalidArgument, key + " must be a string");
  }
  return val.get<std::string>();
}

static int parseUpscaleRepeats(const picojson::value& val) {
  const double raw = requireNum(val, "upscale.repeats");
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

// -- Enum parsers -------------------------------------------------------------

static sample_method_t parseSampler(const std::string& name) {
  static const std::unordered_map<std::string, sample_method_t> samplers{
      {"euler", EULER_SAMPLE_METHOD},
      {"euler_a", EULER_A_SAMPLE_METHOD},
      {"heun", HEUN_SAMPLE_METHOD},
      {"dpm2", DPM2_SAMPLE_METHOD},
      {"dpm++2m", DPMPP2M_SAMPLE_METHOD},
      {"dpm++2mv2", DPMPP2Mv2_SAMPLE_METHOD},
      {"dpm++2s_a", DPMPP2S_A_SAMPLE_METHOD},
      {"lcm", LCM_SAMPLE_METHOD},
      {"ipndm", IPNDM_SAMPLE_METHOD},
      {"ipndm_v", IPNDM_V_SAMPLE_METHOD},
      {"ddim_trailing", DDIM_TRAILING_SAMPLE_METHOD},
      {"tcd", TCD_SAMPLE_METHOD},
      {"res_multistep", RES_MULTISTEP_SAMPLE_METHOD},
      {"res_2s", RES_2S_SAMPLE_METHOD},
  };
  if (auto iter = samplers.find(name); iter != samplers.end()) {
    return iter->second;
  }
  throw StatusError(
      general_error::InvalidArgument,
      "sampling_method: unknown value '" + name +
          "'. Valid: euler, euler_a, heun, dpm2, dpm++2m, dpm++2mv2, "
          "dpm++2s_a, lcm, ipndm, ipndm_v, ddim_trailing, tcd, "
          "res_multistep, res_2s");
}

static scheduler_t parseScheduler(const std::string& name) {
  static const std::unordered_map<std::string, scheduler_t> schedulers{
      {"discrete", DISCRETE_SCHEDULER},
      {"karras", KARRAS_SCHEDULER},
      {"exponential", EXPONENTIAL_SCHEDULER},
      {"ays", AYS_SCHEDULER},
      {"gits", GITS_SCHEDULER},
      {"sgm_uniform", SGM_UNIFORM_SCHEDULER},
      {"simple", SIMPLE_SCHEDULER},
      {"lcm", LCM_SCHEDULER},
      {"smoothstep", SMOOTHSTEP_SCHEDULER},
      {"kl_optimal", KL_OPTIMAL_SCHEDULER},
      {"bong_tangent", BONG_TANGENT_SCHEDULER},
  };
  if (auto iter = schedulers.find(name); iter != schedulers.end()) {
    return iter->second;
  }
  throw StatusError(
      general_error::InvalidArgument,
      "scheduler: unknown value '" + name +
          "'. Valid: discrete, karras, exponential, ays, gits, "
          "sgm_uniform, simple, lcm, smoothstep, kl_optimal, bong_tangent");
}

// Parses "vae_tile_size": accepts either an integer (applied to both axes)
// or a "WxH" string (e.g. "128x64").
static std::pair<int, int> parseVaeTileSize(const picojson::value& val) {
  if (val.is<double>()) {
    int size = static_cast<int>(val.get<double>());
    return {size, size};
  }
  if (!val.is<std::string>()) {
    throw StatusError(
        general_error::InvalidArgument,
        "vae_tile_size must be a number or 'WxH' string");
  }

  const std::string_view tileStr = val.get<std::string>();
  const auto xPos = tileStr.find('x');
  if (xPos == std::string_view::npos) {
    throw StatusError(
        general_error::InvalidArgument,
        "vae_tile_size string must be 'WxH', got: '" + std::string(tileStr) +
            "'");
  }

  int tileW{};
  int tileH{};
  const auto wSv = tileStr.substr(0, xPos);
  const auto hSv = tileStr.substr(xPos + 1);
  // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  if (std::from_chars(wSv.data(), wSv.data() + wSv.size(), tileW).ec !=
          std::errc{} ||
      // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::from_chars(hSv.data(), hSv.data() + hSv.size(), tileH).ec !=
          std::errc{}) {
    throw StatusError(
        general_error::InvalidArgument,
        "vae_tile_size: could not parse dimensions from '" +
            std::string(tileStr) + "'");
  }
  return {tileW, tileH};
}

static sd_cache_mode_t parseCacheMode(const std::string& name) {
  static const std::unordered_map<std::string, sd_cache_mode_t> cacheModes{
      {"", SD_CACHE_DISABLED},
      {"disabled", SD_CACHE_DISABLED},
      {"easycache", SD_CACHE_EASYCACHE},
      {"ucache", SD_CACHE_UCACHE},
      {"dbcache", SD_CACHE_DBCACHE},
      {"taylorseer", SD_CACHE_TAYLORSEER},
      {"cache-dit", SD_CACHE_CACHE_DIT},
  };
  if (auto iter = cacheModes.find(name); iter != cacheModes.end()) {
    return iter->second;
  }
  throw StatusError(
      general_error::InvalidArgument,
      "cache_mode: unknown value '" + name +
          "'. Valid: disabled, easycache, ucache, dbcache, taylorseer, "
          "cache-dit");
}

// Minimum alignment for image dimensions required by all supported model
// families (SD2.x, SDXL, SD3, FLUX.2). The latent space uses 8-pixel blocks.
static constexpr int DIM_ALIGNMENT = 8;

// -- Handler map
// ---------------------------------------------------------------

// NOLINTNEXTLINE(bugprone-throwing-static-initialization)
const SdGenHandlersMap SD_GEN_HANDLERS = {

    // -- Mode
    // --------------------------------------------------------------------

    {"mode",
     [](SdGenConfig& cfg, const picojson::value& val) {
       const auto mode = requireStr(val, "mode");
       if (mode != "txt2img" && mode != "img2img") {
         throw StatusError(
             general_error::InvalidArgument,
             "mode must be 'txt2img' or 'img2img', got: '" + mode + "'");
       }
       cfg.mode = mode;
     }},

    // -- Prompt
    // ------------------------------------------------------------------

    {"prompt",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.prompt = requireStr(val, "prompt");
     }},
    {"negative_prompt",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.negativePrompt = requireStr(val, "negative_prompt");
     }},
    {"lora",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.loraPath = requireStr(val, "lora");
     }},

    // -- Image dimensions
    // --------------------------------------------------------

    {"width",
     [](SdGenConfig& cfg, const picojson::value& val) {
       int width = static_cast<int>(requireNum(val, "width"));
       if (width <= 0 || width % DIM_ALIGNMENT != 0) {
         throw StatusError(
             general_error::InvalidArgument,
             "width must be a positive multiple of 8, got: " +
                 std::to_string(width));
       }
       cfg.width = width;
     }},

    {"height",
     [](SdGenConfig& cfg, const picojson::value& val) {
       int height = static_cast<int>(requireNum(val, "height"));
       if (height <= 0 || height % DIM_ALIGNMENT != 0) {
         throw StatusError(
             general_error::InvalidArgument,
             "height must be a positive multiple of 8, got: " +
                 std::to_string(height));
       }
       cfg.height = height;
     }},

    // -- Sampling
    // ----------------------------------------------------------------

    {"steps",
     [](SdGenConfig& cfg, const picojson::value& val) {
       int steps = static_cast<int>(requireNum(val, "steps"));
       if (steps <= 0) {
         throw StatusError(general_error::InvalidArgument, "steps must be > 0");
       }
       cfg.steps = steps;
     }},

    // Both "sampling_method" and "sampler" are accepted.
    {"sampling_method",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.sampleMethod = parseSampler(requireStr(val, "sampling_method"));
     }},
    {"sampler",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.sampleMethod = parseSampler(requireStr(val, "sampler"));
     }},

    {"scheduler",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.scheduler = parseScheduler(requireStr(val, "scheduler"));
     }},

    {"eta",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.eta = static_cast<float>(requireNum(val, "eta"));
     }},

    // -- Guidance
    // ----------------------------------------------------------------

    {"cfg_scale",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.cfgScale = static_cast<float>(requireNum(val, "cfg_scale"));
     }},

    // distilled_guidance -- FLUX.2 specific; separate from cfg_scale.
    // Default 3.5 is the FLUX recommendation. Too low = washed out, too high =
    // over-saturated.
    {"guidance",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.guidance = static_cast<float>(requireNum(val, "guidance"));
     }},

    // img_cfg -- image guidance for img2img / inpaint workflows; -1 = use
    // cfg_scale.
    {"img_cfg_scale",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.imgCfgScale = static_cast<float>(requireNum(val, "img_cfg_scale"));
     }},

    // -- Reproducibility
    // ---------------------------------------------------------

    {"seed",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.seed = static_cast<int64_t>(requireNum(val, "seed"));
     }},

    // -- Batching
    // ----------------------------------------------------------------

    {"batch_count",
     [](SdGenConfig& cfg, const picojson::value& val) {
       int batchSize = static_cast<int>(requireNum(val, "batch_count"));
       if (batchSize <= 0) {
         throw StatusError(
             general_error::InvalidArgument, "batch_count must be > 0");
       }
       cfg.batchCount = batchSize;
     }},

    // -- img2img
    // -----------------------------------------------------------------

    {"strength",
     [](SdGenConfig& cfg, const picojson::value& val) {
       float strength = static_cast<float>(requireNum(val, "strength"));
       if (strength < 0.0F || strength > 1.0F) {
         throw StatusError(
             general_error::InvalidArgument,
             "strength must be in [0, 1], got: " + std::to_string(strength));
       }
       cfg.strength = strength;
     }},

    // clip_skip -- skip last N CLIP layers. Used by SD2.x fine-tunes.
    // -1 = auto (SD2 default is 2). Ignored for FLUX.
    {"clip_skip",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.clipSkip = static_cast<int>(requireNum(val, "clip_skip"));
     }},

    // -- VAE tiling
    // --------------------------------------------------------------

    {"vae_tiling",
     [](SdGenConfig& cfg, const picojson::value& val) {
       if (!val.is<bool>()) {
         throw StatusError(
             general_error::InvalidArgument, "vae_tiling must be a boolean");
       }
       cfg.vaeTiling = val.get<bool>();
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
     [](SdGenConfig& cfg, const picojson::value& val) {
       if (!val.is<bool>()) {
         throw StatusError(
             general_error::InvalidArgument,
             "increase_ref_index must be a boolean");
       }
       cfg.increaseRefIndex = val.get<bool>();
     }},

    {"auto_resize_ref_image",
     [](SdGenConfig& cfg, const picojson::value& val) {
       if (!val.is<bool>()) {
         throw StatusError(
             general_error::InvalidArgument,
             "auto_resize_ref_image must be a boolean");
       }
       cfg.autoResizeRefImage = val.get<bool>();
     }},

    // vae_tile_size accepts either an integer (applied to both axes) or "WxH"
    // string.
    {"vae_tile_size",
     [](SdGenConfig& cfg, const picojson::value& val) {
       auto [tileW, tileH] = parseVaeTileSize(val);
       cfg.vaeTileSizeX = tileW;
       cfg.vaeTileSizeY = tileH;
     }},

    {"vae_tile_overlap",
     [](SdGenConfig& cfg, const picojson::value& val) {
       float overlap = static_cast<float>(requireNum(val, "vae_tile_overlap"));
       if (overlap < 0.0F || overlap >= 1.0F) {
         throw StatusError(
             general_error::InvalidArgument,
             "vae_tile_overlap must be in [0, 1), got: " +
                 std::to_string(overlap));
       }
       cfg.vaeTileOverlap = overlap;
     }},

    // -- Step-caching
    // ------------------------------------------------------------
    // cache_mode selects the algorithm. cache_preset is a convenience shorthand
    // that sets both the mode and sensible threshold defaults.

    {"cache_mode",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.cacheMode = parseCacheMode(requireStr(val, "cache_mode"));
     }},

    // cache_preset -- shorthand for "easycache + threshold".
    {"cache_preset",
     [](SdGenConfig& cfg, const picojson::value& val) {
       // Approximate threshold values mirroring the stable-diffusion.cpp CLI
       // presets:  slow ~= 0.60 (~10% speed-up)  medium ~= 0.40 (~25%)
       //           fast ~= 0.25 (~40%)            ultra  ~= 0.15 (fastest)
       using Preset = std::pair<sd_cache_mode_t, float>;
       static const std::unordered_map<std::string, Preset> presets{
           {"slow", {SD_CACHE_EASYCACHE, 0.60F}},
           {"medium", {SD_CACHE_EASYCACHE, 0.40F}},
           {"fast", {SD_CACHE_EASYCACHE, 0.25F}},
           {"ultra", {SD_CACHE_EASYCACHE, 0.15F}},
       };
       const auto preset = requireStr(val, "cache_preset");
       if (auto iter = presets.find(preset); iter != presets.end()) {
         cfg.cacheMode = iter->second.first;
         cfg.cacheThreshold = iter->second.second;
       } else {
         throw StatusError(
             general_error::InvalidArgument,
             "cache_preset must be 'slow', 'medium', 'fast', or 'ultra'");
       }
     }},

    // cache_threshold -- direct override for reuse_threshold; 0 = library
    // default.
    {"cache_threshold",
     [](SdGenConfig& cfg, const picojson::value& val) {
       cfg.cacheThreshold =
           static_cast<float>(requireNum(val, "cache_threshold"));
     }},

    // ── Post-generation ESRGAN upscale
    // ──────────────────────────────────────

    {"upscale",
     [](SdGenConfig& cfg, const picojson::value& val) {
       if (val.is<bool>()) {
         cfg.upscale = val.get<bool>();
         cfg.upscaleRepeats = 1;
         return;
       }

       if (!val.is<picojson::object>()) {
         throw StatusError(
             general_error::InvalidArgument,
             "upscale must be a boolean or an object");
       }

       cfg.upscale = true;
       cfg.upscaleRepeats = 1;

       const auto& obj = val.get<picojson::object>();
       if (auto iter = obj.find("repeats"); iter != obj.end()) {
         cfg.upscaleRepeats = parseUpscaleRepeats(iter->second);
       }
     }},

};

// -----------------------------------------------------------------------------

void applySdGenHandlers(SdGenConfig& config, const picojson::object& obj) {
  for (const auto& [key, value] : obj) {
    if (auto iter = SD_GEN_HANDLERS.find(key); iter != SD_GEN_HANDLERS.end()) {
      iter->second(config, value);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

} // namespace qvac_lib_inference_addon_sd

#include "SdGenHandlers.hpp"

#include <charconv>
#include <string_view>
#include <unordered_map>
#include <utility>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;

// -- JSON value helpers
// --------------------------------------------------------

static double requireNum(const picojson::value& v, const std::string& key) {
  if (!v.is<double>())
    throw StatusError(
        general_error::InvalidArgument, key + " must be a number");
  return v.get<double>();
}

static std::string
requireStr(const picojson::value& v, const std::string& key) {
  if (!v.is<std::string>())
    throw StatusError(
        general_error::InvalidArgument, key + " must be a string");
  return v.get<std::string>();
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
  if (auto it = samplers.find(name); it != samplers.end()) {
    return it->second;
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
  if (auto it = schedulers.find(name); it != schedulers.end()) {
    return it->second;
  }
  throw StatusError(
      general_error::InvalidArgument,
      "scheduler: unknown value '" + name +
          "'. Valid: discrete, karras, exponential, ays, gits, "
          "sgm_uniform, simple, lcm, smoothstep, kl_optimal, bong_tangent");
}

// Parses "vae_tile_size": accepts either an integer (applied to both axes)
// or a "WxH" string (e.g. "128x64").
static std::pair<int, int> parseVaeTileSize(const picojson::value& v) {
  if (v.is<double>()) {
    int sz = static_cast<int>(v.get<double>());
    return {sz, sz};
  }
  if (!v.is<std::string>()) {
    throw StatusError(
        general_error::InvalidArgument,
        "vae_tile_size must be a number or 'WxH' string");
  }

  const std::string_view s = v.get<std::string>();
  const auto xPos = s.find('x');
  if (xPos == std::string_view::npos) {
    throw StatusError(
        general_error::InvalidArgument,
        "vae_tile_size string must be 'WxH', got: '" + std::string(s) + "'");
  }

  int w{}, h{};
  const auto wSv = s.substr(0, xPos);
  const auto hSv = s.substr(xPos + 1);
  if (std::from_chars(wSv.data(), wSv.data() + wSv.size(), w).ec !=
          std::errc{} ||
      std::from_chars(hSv.data(), hSv.data() + hSv.size(), h).ec !=
          std::errc{}) {
    throw StatusError(
        general_error::InvalidArgument,
        "vae_tile_size: could not parse dimensions from '" + std::string(s) +
            "'");
  }
  return {w, h};
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
  if (auto it = cacheModes.find(name); it != cacheModes.end()) {
    return it->second;
  }
  throw StatusError(
      general_error::InvalidArgument,
      "cache_mode: unknown value '" + name +
          "'. Valid: disabled, easycache, ucache, dbcache, taylorseer, "
          "cache-dit");
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
       if (!v.is<bool>())
         throw StatusError(
             general_error::InvalidArgument, "vae_tiling must be a boolean");
       c.vaeTiling = v.get<bool>();
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
       if (!v.is<bool>())
         throw StatusError(
             general_error::InvalidArgument,
             "increase_ref_index must be a boolean");
       c.increaseRefIndex = v.get<bool>();
     }},

    {"auto_resize_ref_image",
     [](SdGenConfig& c, const picojson::value& v) {
       if (!v.is<bool>())
         throw StatusError(
             general_error::InvalidArgument,
             "auto_resize_ref_image must be a boolean");
       c.autoResizeRefImage = v.get<bool>();
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
       // Approximate threshold values mirroring the stable-diffusion.cpp CLI
       // presets:  slow ~= 0.60 (~10% speed-up)  medium ~= 0.40 (~25%)
       //           fast ~= 0.25 (~40%)            ultra  ~= 0.15 (fastest)
       using Preset = std::pair<sd_cache_mode_t, float>;
       static const std::unordered_map<std::string, Preset> presets{
           {"slow", {SD_CACHE_EASYCACHE, 0.60f}},
           {"medium", {SD_CACHE_EASYCACHE, 0.40f}},
           {"fast", {SD_CACHE_EASYCACHE, 0.25f}},
           {"ultra", {SD_CACHE_EASYCACHE, 0.15f}},
       };
       const auto preset = requireStr(v, "cache_preset");
       if (auto it = presets.find(preset); it != presets.end()) {
         c.cacheMode = it->second.first;
         c.cacheThreshold = it->second.second;
       } else {
         throw StatusError(
             general_error::InvalidArgument,
             "cache_preset must be 'slow', 'medium', 'fast', or 'ultra'");
       }
     }},

    // cache_threshold -- direct override for reuse_threshold; 0 = library
    // default.
    {"cache_threshold",
     [](SdGenConfig& c, const picojson::value& v) {
       c.cacheThreshold = static_cast<float>(requireNum(v, "cache_threshold"));
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

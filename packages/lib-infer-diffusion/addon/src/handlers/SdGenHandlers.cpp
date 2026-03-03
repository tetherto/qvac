#include "SdGenHandlers.hpp"

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

namespace qvac_lib_inference_addon_sd {

using namespace qvac_errors;

// ── JSON value helpers ────────────────────────────────────────────────────────

static double requireNum(const picojson::value& v, const std::string& key) {
  if (!v.is<double>())
    throw StatusError(general_error::InvalidArgument, key + " must be a number");
  return v.get<double>();
}

static std::string requireStr(const picojson::value& v, const std::string& key) {
  if (!v.is<std::string>())
    throw StatusError(general_error::InvalidArgument, key + " must be a string");
  return v.get<std::string>();
}

// ── Enum parsers ─────────────────────────────────────────────────────────────

static sample_method_t parseSampler(const std::string& name) {
  // Euler (FLUX default)
  if (name == "euler")          return EULER_SAMPLE_METHOD;
  if (name == "euler_a")        return EULER_A_SAMPLE_METHOD;
  // Classic SD
  if (name == "heun")           return HEUN_SAMPLE_METHOD;
  if (name == "dpm2")           return DPM2_SAMPLE_METHOD;
  if (name == "dpm++2m")        return DPMPP2M_SAMPLE_METHOD;
  if (name == "dpm++2mv2")      return DPMPP2Mv2_SAMPLE_METHOD;
  if (name == "dpm++2s_a")      return DPMPP2S_A_SAMPLE_METHOD;
  if (name == "lcm")            return LCM_SAMPLE_METHOD;
  // Additional
  if (name == "ipndm")          return IPNDM_SAMPLE_METHOD;
  if (name == "ipndm_v")        return IPNDM_V_SAMPLE_METHOD;
  if (name == "ddim_trailing")  return DDIM_TRAILING_SAMPLE_METHOD;
  if (name == "tcd")            return TCD_SAMPLE_METHOD;
  if (name == "res_multistep")  return RES_MULTISTEP_SAMPLE_METHOD;
  if (name == "res_2s")         return RES_2S_SAMPLE_METHOD;
  throw StatusError(general_error::InvalidArgument,
                    "sampling_method: unknown value '" + name + "'. "
                    "Valid: euler, euler_a, heun, dpm2, dpm++2m, dpm++2mv2, "
                    "dpm++2s_a, lcm, ipndm, ipndm_v, ddim_trailing, tcd, "
                    "res_multistep, res_2s");
}

static scheduler_t parseScheduler(const std::string& name) {
  if (name == "discrete")     return DISCRETE_SCHEDULER;
  if (name == "karras")       return KARRAS_SCHEDULER;
  if (name == "exponential")  return EXPONENTIAL_SCHEDULER;
  if (name == "ays")          return AYS_SCHEDULER;
  if (name == "gits")         return GITS_SCHEDULER;
  if (name == "sgm_uniform")  return SGM_UNIFORM_SCHEDULER;
  if (name == "simple")       return SIMPLE_SCHEDULER;
  if (name == "lcm")          return LCM_SCHEDULER;
  if (name == "smoothstep")   return SMOOTHSTEP_SCHEDULER;
  if (name == "kl_optimal")   return KL_OPTIMAL_SCHEDULER;
  if (name == "bong_tangent") return BONG_TANGENT_SCHEDULER;
  throw StatusError(general_error::InvalidArgument,
                    "scheduler: unknown value '" + name + "'. "
                    "Valid: discrete, karras, exponential, ays, gits, "
                    "sgm_uniform, simple, lcm, smoothstep, kl_optimal, bong_tangent");
}

static sd_cache_mode_t parseCacheMode(const std::string& name) {
  if (name == "disabled"   || name == "") return SD_CACHE_DISABLED;
  if (name == "easycache")                return SD_CACHE_EASYCACHE;
  if (name == "ucache")                   return SD_CACHE_UCACHE;
  if (name == "dbcache")                  return SD_CACHE_DBCACHE;
  if (name == "taylorseer")               return SD_CACHE_TAYLORSEER;
  if (name == "cache-dit")                return SD_CACHE_CACHE_DIT;
  throw StatusError(general_error::InvalidArgument,
                    "cache_mode: unknown value '" + name + "'. "
                    "Valid: disabled, easycache, ucache, dbcache, taylorseer, cache-dit");
}

// ── Handler map ───────────────────────────────────────────────────────────────

const SdGenHandlersMap SD_GEN_HANDLERS = {

  // ── Mode ────────────────────────────────────────────────────────────────────

  {"mode", [](SdGenConfig& c, const picojson::value& v) {
    const auto mode = requireStr(v, "mode");
    if (mode != "txt2img" && mode != "img2img")
      throw StatusError(general_error::InvalidArgument,
                        "mode must be 'txt2img' or 'img2img', got: '" + mode + "'");
    c.mode = mode;
  }},

  // ── Prompt ──────────────────────────────────────────────────────────────────

  {"prompt",          [](SdGenConfig& c, const picojson::value& v) { c.prompt         = requireStr(v, "prompt"); }},
  {"negative_prompt", [](SdGenConfig& c, const picojson::value& v) { c.negativePrompt = requireStr(v, "negative_prompt"); }},

  // ── Image dimensions ────────────────────────────────────────────────────────

  {"width", [](SdGenConfig& c, const picojson::value& v) {
    int w = static_cast<int>(requireNum(v, "width"));
    if (w <= 0 || w % 8 != 0)
      throw StatusError(general_error::InvalidArgument,
                        "width must be a positive multiple of 8, got: " + std::to_string(w));
    c.width = w;
  }},

  {"height", [](SdGenConfig& c, const picojson::value& v) {
    int h = static_cast<int>(requireNum(v, "height"));
    if (h <= 0 || h % 8 != 0)
      throw StatusError(general_error::InvalidArgument,
                        "height must be a positive multiple of 8, got: " + std::to_string(h));
    c.height = h;
  }},

  // ── Sampling ────────────────────────────────────────────────────────────────

  {"steps", [](SdGenConfig& c, const picojson::value& v) {
    int s = static_cast<int>(requireNum(v, "steps"));
    if (s <= 0)
      throw StatusError(general_error::InvalidArgument, "steps must be > 0");
    c.steps = s;
  }},

  // Both "sampling_method" and "sampler" are accepted.
  {"sampling_method", [](SdGenConfig& c, const picojson::value& v) { c.sampleMethod = parseSampler(requireStr(v, "sampling_method")); }},
  {"sampler",         [](SdGenConfig& c, const picojson::value& v) { c.sampleMethod = parseSampler(requireStr(v, "sampler")); }},

  {"scheduler", [](SdGenConfig& c, const picojson::value& v) {
    c.scheduler = parseScheduler(requireStr(v, "scheduler"));
  }},

  {"eta", [](SdGenConfig& c, const picojson::value& v) {
    c.eta = static_cast<float>(requireNum(v, "eta"));
  }},

  // ── Guidance ────────────────────────────────────────────────────────────────

  {"cfg_scale", [](SdGenConfig& c, const picojson::value& v) {
    c.cfgScale = static_cast<float>(requireNum(v, "cfg_scale"));
  }},

  // distilled_guidance — FLUX.2 specific; separate from cfg_scale.
  // Default 3.5 is the FLUX recommendation. Too low = washed out, too high = over-saturated.
  {"guidance", [](SdGenConfig& c, const picojson::value& v) {
    c.guidance = static_cast<float>(requireNum(v, "guidance"));
  }},

  // img_cfg — image guidance for img2img / inpaint workflows; -1 = use cfg_scale.
  {"img_cfg_scale", [](SdGenConfig& c, const picojson::value& v) {
    c.imgCfgScale = static_cast<float>(requireNum(v, "img_cfg_scale"));
  }},

  // ── Reproducibility ─────────────────────────────────────────────────────────

  {"seed", [](SdGenConfig& c, const picojson::value& v) {
    c.seed = static_cast<int64_t>(requireNum(v, "seed"));
  }},

  // ── Batching ────────────────────────────────────────────────────────────────

  {"batch_count", [](SdGenConfig& c, const picojson::value& v) {
    int b = static_cast<int>(requireNum(v, "batch_count"));
    if (b <= 0)
      throw StatusError(general_error::InvalidArgument, "batch_count must be > 0");
    c.batchCount = b;
  }},

  // ── img2img ─────────────────────────────────────────────────────────────────

  {"strength", [](SdGenConfig& c, const picojson::value& v) {
    float s = static_cast<float>(requireNum(v, "strength"));
    if (s < 0.0f || s > 1.0f)
      throw StatusError(general_error::InvalidArgument,
                        "strength must be in [0, 1], got: " + std::to_string(s));
    c.strength = s;
  }},

  // clip_skip — skip last N CLIP layers. Used by SD1.x / SD2.x fine-tunes.
  // -1 = auto (1 for SD1, 2 for SD2). Ignored for FLUX.
  {"clip_skip", [](SdGenConfig& c, const picojson::value& v) {
    c.clipSkip = static_cast<int>(requireNum(v, "clip_skip"));
  }},

  // ── VAE tiling ──────────────────────────────────────────────────────────────

  {"vae_tiling", [](SdGenConfig& c, const picojson::value& v) {
    if (!v.is<bool>())
      throw StatusError(general_error::InvalidArgument, "vae_tiling must be a boolean");
    c.vaeTiling = v.get<bool>();
  }},

  // vae_tile_size accepts either an integer (applied to both axes) or "WxH" string.
  {"vae_tile_size", [](SdGenConfig& c, const picojson::value& v) {
    if (v.is<double>()) {
      int sz = static_cast<int>(v.get<double>());
      c.vaeTileSizeX = sz;
      c.vaeTileSizeY = sz;
    } else if (v.is<std::string>()) {
      const auto& s = v.get<std::string>();
      size_t xPos = s.find('x');
      if (xPos == std::string::npos)
        throw StatusError(general_error::InvalidArgument,
                          "vae_tile_size string must be 'WxH', got: '" + s + "'");
      try {
        c.vaeTileSizeX = std::stoi(s.substr(0, xPos));
        c.vaeTileSizeY = std::stoi(s.substr(xPos + 1));
      } catch (...) {
        throw StatusError(general_error::InvalidArgument,
                          "vae_tile_size: could not parse dimensions from '" + s + "'");
      }
    } else {
      throw StatusError(general_error::InvalidArgument,
                        "vae_tile_size must be a number or 'WxH' string");
    }
  }},

  {"vae_tile_overlap", [](SdGenConfig& c, const picojson::value& v) {
    float overlap = static_cast<float>(requireNum(v, "vae_tile_overlap"));
    if (overlap < 0.0f || overlap >= 1.0f)
      throw StatusError(general_error::InvalidArgument,
                        "vae_tile_overlap must be in [0, 1), got: " + std::to_string(overlap));
    c.vaeTileOverlap = overlap;
  }},

  // ── Step-caching ────────────────────────────────────────────────────────────
  // cache_mode selects the algorithm. cache_preset is a convenience shorthand
  // that sets both the mode and sensible threshold defaults.

  {"cache_mode", [](SdGenConfig& c, const picojson::value& v) {
    c.cacheMode = parseCacheMode(requireStr(v, "cache_mode"));
  }},

  // cache_preset — shorthand for "easycache + threshold".
  // Approximate threshold values mirroring the stable-diffusion.cpp CLI presets:
  //   slow   ≈ 0.60   (safest, ~10% speed-up)
  //   medium ≈ 0.40   (~25% speed-up)
  //   fast   ≈ 0.25   (~40% speed-up)
  //   ultra  ≈ 0.15   (fastest, some quality loss)
  {"cache_preset", [](SdGenConfig& c, const picojson::value& v) {
    const auto preset = requireStr(v, "cache_preset");
    if (preset == "slow")        { c.cacheMode = SD_CACHE_EASYCACHE; c.cacheThreshold = 0.60f; }
    else if (preset == "medium") { c.cacheMode = SD_CACHE_EASYCACHE; c.cacheThreshold = 0.40f; }
    else if (preset == "fast")   { c.cacheMode = SD_CACHE_EASYCACHE; c.cacheThreshold = 0.25f; }
    else if (preset == "ultra")  { c.cacheMode = SD_CACHE_EASYCACHE; c.cacheThreshold = 0.15f; }
    else throw StatusError(general_error::InvalidArgument,
                           "cache_preset must be 'slow', 'medium', 'fast', or 'ultra'");
  }},

  // cache_threshold — direct override for reuse_threshold; 0 = library default.
  {"cache_threshold", [](SdGenConfig& c, const picojson::value& v) {
    c.cacheThreshold = static_cast<float>(requireNum(v, "cache_threshold"));
  }},

};

// ─────────────────────────────────────────────────────────────────────────────

void applySdGenHandlers(SdGenConfig& config, const picojson::object& obj) {
  for (const auto& [key, value] : obj) {
    if (auto it = SD_GEN_HANDLERS.find(key); it != SD_GEN_HANDLERS.end()) {
      it->second(config, value);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

} // namespace qvac_lib_inference_addon_sd

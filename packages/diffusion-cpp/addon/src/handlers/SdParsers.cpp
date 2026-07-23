#include "SdParsers.hpp"

#include <charconv>
#include <climits>
#include <cmath>
#include <cstdint>
#include <string_view>
#include <unordered_map>

#include <inference-addon-cpp/Errors.hpp>

namespace qvac_lib_inference_addon_sd::parsers {

using namespace qvac_errors;

// -- JSON value helpers -------------------------------------------------------

double requireNum(const picojson::value& v, const std::string& key) {
  if (!v.is<double>())
    throw StatusError(
        general_error::InvalidArgument, key + " must be a number");
  return v.get<double>();
}

std::string requireStr(const picojson::value& v, const std::string& key) {
  if (!v.is<std::string>())
    throw StatusError(
        general_error::InvalidArgument, key + " must be a string");
  return v.get<std::string>();
}

bool requireBool(const picojson::value& v, const std::string& key) {
  if (!v.is<bool>())
    throw StatusError(
        general_error::InvalidArgument, key + " must be a boolean");
  return v.get<bool>();
}

// Largest integer JSON (IEEE 754 double) can losslessly represent. Used by
// requireInt64 to reject silent precision loss for large seeds.
inline constexpr double MAX_SAFE_JSON_INT = 9007199254740992.0; // 2^53

int requireInt(const picojson::value& v, const std::string& key) {
  const double d = requireNum(v, key);
  if (!std::isfinite(d)) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be a finite integer, got: " + std::to_string(d));
  }
  if (d != std::floor(d)) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be an integer, got: " + std::to_string(d));
  }
  if (d < static_cast<double>(INT_MIN) || d > static_cast<double>(INT_MAX)) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " is out of int range, got: " + std::to_string(d));
  }
  return static_cast<int>(d);
}

int requirePositiveInt(const picojson::value& v, const std::string& key) {
  const int n = requireInt(v, key);
  if (n <= 0)
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be > 0, got: " + std::to_string(n));
  return n;
}

int64_t requireInt64(const picojson::value& v, const std::string& key) {
  const double d = requireNum(v, key);
  if (!std::isfinite(d)) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be a finite integer, got: " + std::to_string(d));
  }
  if (d != std::floor(d)) {
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be an integer, got: " + std::to_string(d));
  }
  if (d < -MAX_SAFE_JSON_INT || d > MAX_SAFE_JSON_INT) {
    throw StatusError(
        general_error::InvalidArgument,
        key +
            " is outside the safe integer range "
            "[-2^53, 2^53], got: " +
            std::to_string(d));
  }
  return static_cast<int64_t>(d);
}

float requireRange(
    const picojson::value& v, const std::string& key, float lo, float hi) {
  const float f = static_cast<float>(requireNum(v, key));
  // Guard against NaN: both `<` and `>` comparisons are false for NaN, so the
  // range check below would otherwise let it through to the native layer.
  if (!std::isfinite(f))
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be a finite number, got: " + std::to_string(f));
  if (f < lo || f > hi)
    throw StatusError(
        general_error::InvalidArgument,
        key + " must be in [" + std::to_string(lo) + ", " + std::to_string(hi) +
            "], got: " + std::to_string(f));
  return f;
}

// -- Enum parsers -------------------------------------------------------------

sample_method_t parseSampler(const std::string& name) {
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

scheduler_t parseScheduler(const std::string& name) {
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

sd_cache_mode_t parseCacheMode(const std::string& name) {
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

std::pair<int, int> parseVaeTileSize(const picojson::value& v) {
  if (v.is<double>()) {
    const double raw = v.get<double>();
    if (!std::isfinite(raw) || std::floor(raw) != raw ||
        raw > static_cast<double>(std::numeric_limits<int>::max()) ||
        raw < static_cast<double>(std::numeric_limits<int>::min()))
      throw StatusError(
          general_error::InvalidArgument,
          "vae_tile_size must be a positive integer");
    const int sz = static_cast<int>(raw);
    if (sz <= 0)
      throw StatusError(
          general_error::InvalidArgument,
          "vae_tile_size must be a positive integer, got: " +
              std::to_string(sz));
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
  if (w <= 0 || h <= 0)
    throw StatusError(
        general_error::InvalidArgument,
        "vae_tile_size dimensions must be positive, got: '" + std::string(s) +
            "'");
  return {w, h};
}

std::pair<sd_cache_mode_t, float> parseCachePreset(const std::string& preset) {
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
  if (auto it = presets.find(preset); it != presets.end()) {
    return it->second;
  }
  throw StatusError(
      general_error::InvalidArgument,
      "cache_preset must be 'slow', 'medium', 'fast', or 'ultra'");
}

} // namespace qvac_lib_inference_addon_sd::parsers

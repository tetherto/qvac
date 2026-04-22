#include "js-interface/JSAdapter.hpp"

#include <optional>
#include <string>

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac::ttsggml {

namespace js = qvac_lib_inference_addon_cpp::js;
namespace general_error = qvac_errors::general_error;

namespace {

// Numeric properties arrive from JS as a JS Number (current) or JS
// String (legacy callers who stringify ints before crossing the
// boundary).  Accept both; missing / null / undefined → nullopt; any
// other type or a non-parseable numeric string throws
// StatusError(InvalidArgument) — the previous string-map path
// silently dropped malformed values via a catch-all, which hid bugs.
std::optional<int> readOptionalInt(
    js::Object obj, js_env_t* env, const char* key) {
  js_value_t* raw = obj.getProperty(env, key);
  if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
    return std::nullopt;
  }
  if (js::is<js::Number>(env, raw)) {
    return static_cast<int>(js::Number::fromValue(raw).as<double>(env));
  }
  if (js::is<js::String>(env, raw)) {
    const std::string str = js::String::fromValue(raw).as<std::string>(env);
    try {
      return std::stoi(str);
    } catch (const std::exception&) {
      throw qvac_errors::StatusError(
          general_error::InvalidArgument,
          std::string("Property '") + key +
              "' must be an integer (got non-numeric string \"" + str + "\")");
    }
  }
  throw qvac_errors::StatusError(
      general_error::InvalidArgument,
      std::string("Property '") + key + "' must be a number or numeric string");
}

std::string readOptionalString(
    js::Object obj, js_env_t* env, const char* key) {
  auto v = obj.getOptionalPropertyAs<js::String, std::string>(env, key);
  return v.value_or(std::string{});
}

bool readOptionalBool(
    js::Object obj, js_env_t* env, const char* key, bool fallback = false) {
  auto b = obj.getOptionalPropertyAs<js::Boolean, bool>(env, key);
  return b.value_or(fallback);
}

} // namespace

chatterbox::ChatterboxConfig JSAdapter::buildConfig(
    js::Object configurationParams, js_env_t* env) {
  chatterbox::ChatterboxConfig cfg;
  cfg.t3ModelPath    = readOptionalString(configurationParams, env, "t3ModelPath");
  cfg.s3genModelPath = readOptionalString(configurationParams, env, "s3genModelPath");
  {
    auto lang = readOptionalString(configurationParams, env, "language");
    if (!lang.empty()) cfg.language = std::move(lang);
  }
  cfg.referenceAudio = readOptionalString(configurationParams, env, "referenceAudio");
  cfg.voiceDir       = readOptionalString(configurationParams, env, "voiceDir");
  cfg.seed                    = readOptionalInt(configurationParams, env, "seed");
  cfg.threads                 = readOptionalInt(configurationParams, env, "threads");
  cfg.nGpuLayers              = readOptionalInt(configurationParams, env, "nGpuLayers");
  cfg.outputSampleRate        = readOptionalInt(configurationParams, env, "outputSampleRate");
  cfg.streamChunkTokens       = readOptionalInt(configurationParams, env, "streamChunkTokens");
  cfg.streamFirstChunkTokens  = readOptionalInt(configurationParams, env, "streamFirstChunkTokens");
  cfg.streamCfmSteps          = readOptionalInt(configurationParams, env, "cfmSteps");
  cfg.useGpu                  = readOptionalBool(configurationParams, env, "useGPU");

  // Note on `outputSampleRate`: accepted and stored on ChatterboxConfig
  // but currently a no-op at the engine level (native output is always
  // 24 kHz).  Retained for forward-compat so callers can set it today;
  // wiring lands when qvac-tts.cpp exposes a resampler.

  return cfg;
}

} // namespace qvac::ttsggml

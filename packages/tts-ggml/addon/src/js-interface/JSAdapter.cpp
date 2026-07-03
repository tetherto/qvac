#include "js-interface/JSAdapter.hpp"

#include <optional>
#include <string>

#include "inference-addon-cpp/Errors.hpp"

namespace qvac::ttsggml {

namespace js = qvac_lib_inference_addon_cpp::js;
namespace general_error = qvac_errors::general_error;

namespace {

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

std::optional<float> readOptionalFloat(
    js::Object obj, js_env_t* env, const char* key) {
  js_value_t* raw = obj.getProperty(env, key);
  if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
    return std::nullopt;
  }
  if (js::is<js::Number>(env, raw)) {
    return static_cast<float>(js::Number::fromValue(raw).as<double>(env));
  }
  if (js::is<js::String>(env, raw)) {
    const std::string str = js::String::fromValue(raw).as<std::string>(env);
    try {
      return std::stof(str);
    } catch (const std::exception&) {
      throw qvac_errors::StatusError(
          general_error::InvalidArgument,
          std::string("Property '") + key +
              "' must be a number (got non-numeric string \"" + str + "\")");
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

std::optional<bool> readOptionalBool(
    js::Object obj, js_env_t* env, const char* key) {
  return obj.getOptionalPropertyAs<js::Boolean, bool>(env, key);
}

}

EngineType JSAdapter::readEngineType(
    js::Object configurationParams, js_env_t* env) {
  const std::string explicitType =
      readOptionalString(configurationParams, env, "engineType");
  if (explicitType == "chatterbox") return EngineType::Chatterbox;
  if (explicitType == "supertonic") return EngineType::Supertonic;
  if (!explicitType.empty()) {
    throw qvac_errors::StatusError(
        general_error::InvalidArgument,
        "engineType must be 'chatterbox' or 'supertonic' (got '" +
            explicitType + "')");
  }

  const std::string supertonicPath =
      readOptionalString(configurationParams, env, "supertonicModelPath");
  if (!supertonicPath.empty()) return EngineType::Supertonic;

  const std::string t3Path =
      readOptionalString(configurationParams, env, "t3ModelPath");
  if (!t3Path.empty()) return EngineType::Chatterbox;

  return EngineType::Chatterbox;
}

chatterbox::ChatterboxConfig JSAdapter::buildChatterboxConfig(
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
  cfg.nCtx                    = readOptionalInt(configurationParams, env, "nCtx");
  cfg.kvCacheType             = readOptionalString(configurationParams, env, "kvCacheType");
  cfg.outputSampleRate        = readOptionalInt(configurationParams, env, "outputSampleRate");
  cfg.speed = readOptionalFloat(configurationParams, env, "speed");
  cfg.streamChunkTokens       = readOptionalInt(configurationParams, env, "streamChunkTokens");
  cfg.streamFirstChunkTokens  = readOptionalInt(configurationParams, env, "streamFirstChunkTokens");
  cfg.streamCfmSteps          = readOptionalInt(configurationParams, env, "cfmSteps");
  // useGPU is tri-state on the C++ side: std::nullopt means "unspecified"
  // (let the engine pick its default); true/false are explicit user
  // intent.  ChatterboxModel::validateConfig rejects useGPU/nGpuLayers
  // conflicts, and toEngineOptions translates explicit-false into
  // n_gpu_layers=0 so CPU is actually forced.
  cfg.useGpu                  = readOptionalBool(configurationParams, env, "useGPU");
  cfg.backendsDir    = readOptionalString(configurationParams, env, "backendsDir");
  cfg.openclCacheDir = readOptionalString(configurationParams, env, "openclCacheDir");
  cfg.mecabDictPath  = readOptionalString(configurationParams, env, "mecabDictPath");
  cfg.cangjieTsvPath = readOptionalString(configurationParams, env, "cangjieTsvPath");
  // LavaSR neural enhancement: a non-empty GGUF path turns it on.
  cfg.enhancerGgufPath =
      readOptionalString(configurationParams, env, "lavasrEnhancerPath");
  return cfg;
}

supertonic::SupertonicConfig JSAdapter::buildSupertonicConfig(
    js::Object configurationParams, js_env_t* env) {
  supertonic::SupertonicConfig cfg;
  cfg.modelGgufPath = readOptionalString(configurationParams, env, "supertonicModelPath");
  cfg.voice         = readOptionalString(configurationParams, env, "voice");
  {
    auto lang = readOptionalString(configurationParams, env, "language");
    if (!lang.empty()) cfg.language = std::move(lang);
  }
  cfg.steps             = readOptionalInt(configurationParams, env, "steps");
  cfg.speed             = readOptionalFloat(configurationParams, env, "speed");
  cfg.seed              = readOptionalInt(configurationParams, env, "seed");
  cfg.threads           = readOptionalInt(configurationParams, env, "threads");
  cfg.nGpuLayers        = readOptionalInt(configurationParams, env, "nGpuLayers");
  cfg.outputSampleRate  = readOptionalInt(configurationParams, env, "outputSampleRate");
  cfg.useGpu            = readOptionalBool(configurationParams, env, "useGPU");
  cfg.noiseNpyPath      = readOptionalString(configurationParams, env, "noiseNpyPath");
  cfg.backendsDir       = readOptionalString(configurationParams, env, "backendsDir");
  cfg.openclCacheDir    = readOptionalString(configurationParams, env, "openclCacheDir");
  // LavaSR neural enhancement: a non-empty GGUF path turns it on.
  cfg.enhancerGgufPath =
      readOptionalString(configurationParams, env, "lavasrEnhancerPath");
  return cfg;
}

}

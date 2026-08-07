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
  if (explicitType == "cosyvoice3")
    return EngineType::Cosyvoice;
  if (explicitType == "parler")
    return EngineType::Parler;
  if (!explicitType.empty()) {
    throw qvac_errors::StatusError(
        general_error::InvalidArgument,
        "engineType must be 'chatterbox', 'supertonic', 'cosyvoice3' or "
        "'parler' (got '" +
            explicitType + "')");
  }

  const std::string cosyvoiceDir =
      readOptionalString(configurationParams, env, "cosyvoiceModelDir");
  if (!cosyvoiceDir.empty())
    return EngineType::Cosyvoice;

  const std::string cosyvoiceLlm =
      readOptionalString(configurationParams, env, "cosyvoiceLlmModelPath");
  if (!cosyvoiceLlm.empty())
    return EngineType::Cosyvoice;

  const std::string supertonicPath =
      readOptionalString(configurationParams, env, "supertonicModelPath");
  if (!supertonicPath.empty()) return EngineType::Supertonic;

  const std::string parlerPath =
      readOptionalString(configurationParams, env, "parlerModelPath");
  if (!parlerPath.empty())
    return EngineType::Parler;

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
  cfg.cfgRate                 = readOptionalFloat(configurationParams, env, "cfgRate");
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
  // LavaSR neural denoiser (runs before the enhancer): a non-empty GGUF path
  // turns it on. The tts-cpp UL-UNAS forward is implemented in
  // qvac-ext-lib-whisper.cpp PR #78 (activates once the pinned tts-cpp has it).
  cfg.denoiserGgufPath =
      readOptionalString(configurationParams, env, "lavasrDenoiserPath");
  return cfg;
}

parler::ParlerDescriptionFields
JSAdapter::readParlerDescriptionFields(js::Object obj, js_env_t* env) {
  parler::ParlerDescriptionFields desc;
  desc.description = readOptionalString(obj, env, "description");
  // voiceDescription is the documented alias; description wins when both set.
  if (desc.description.empty()) {
    desc.description = readOptionalString(obj, env, "voiceDescription");
  }
  desc.voice = readOptionalString(obj, env, "voice");
  desc.emotion = readOptionalString(obj, env, "emotion");
  desc.pitch = readOptionalString(obj, env, "pitch");
  desc.pace = readOptionalString(obj, env, "pace");
  desc.expressivity = readOptionalString(obj, env, "expressivity");
  desc.noise = readOptionalString(obj, env, "noise");
  desc.reverb = readOptionalString(obj, env, "reverb");
  desc.quality = readOptionalString(obj, env, "quality");
  return desc;
}

parler::ParlerConfig
JSAdapter::buildParlerConfig(js::Object configurationParams, js_env_t* env) {
  parler::ParlerConfig cfg;
  cfg.modelGgufPath =
      readOptionalString(configurationParams, env, "parlerModelPath");
  cfg.desc = readParlerDescriptionFields(configurationParams, env);
  cfg.seed = readOptionalInt(configurationParams, env, "seed");
  cfg.threads = readOptionalInt(configurationParams, env, "threads");
  cfg.temperature = readOptionalFloat(configurationParams, env, "temperature");
  cfg.topK = readOptionalInt(configurationParams, env, "topK");
  cfg.topP = readOptionalFloat(configurationParams, env, "topP");
  cfg.maxFrames = readOptionalInt(configurationParams, env, "maxFrames");
  cfg.minNewTokens = readOptionalInt(configurationParams, env, "minNewTokens");
  cfg.outputSampleRate =
      readOptionalInt(configurationParams, env, "outputSampleRate");
  cfg.normalizeNumbers =
      readOptionalBool(configurationParams, env, "normalizeNumbers");
  cfg.streamChunkTokens =
      readOptionalInt(configurationParams, env, "streamChunkTokens");
  cfg.streamFirstChunkTokens =
      readOptionalInt(configurationParams, env, "streamFirstChunkTokens");
  cfg.nGpuLayers = readOptionalInt(configurationParams, env, "nGpuLayers");
  cfg.useGpu = readOptionalBool(configurationParams, env, "useGPU");
  cfg.backendsDir = readOptionalString(configurationParams, env, "backendsDir");
  cfg.enhancerGgufPath =
      readOptionalString(configurationParams, env, "lavasrEnhancerPath");
  cfg.denoiserGgufPath =
      readOptionalString(configurationParams, env, "lavasrDenoiserPath");
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
  cfg.vulkanCacheDir =
      readOptionalString(configurationParams, env, "vulkanCacheDir");
  // LavaSR neural enhancement: a non-empty GGUF path turns it on.
  cfg.enhancerGgufPath =
      readOptionalString(configurationParams, env, "lavasrEnhancerPath");
  // LavaSR neural denoiser (runs before the enhancer): a non-empty GGUF path
  // turns it on. The tts-cpp UL-UNAS forward is implemented in
  // qvac-ext-lib-whisper.cpp PR #78 (activates once the pinned tts-cpp has it).
  cfg.denoiserGgufPath =
      readOptionalString(configurationParams, env, "lavasrDenoiserPath");
  return cfg;
}

cosyvoice::CosyvoiceConfig
JSAdapter::buildCosyvoiceConfig(js::Object configurationParams, js_env_t* env) {
  cosyvoice::CosyvoiceConfig cfg;
  cfg.modelDir =
      readOptionalString(configurationParams, env, "cosyvoiceModelDir");
  cfg.llmModelPath =
      readOptionalString(configurationParams, env, "cosyvoiceLlmModelPath");
  cfg.flowModelPath =
      readOptionalString(configurationParams, env, "cosyvoiceFlowModelPath");
  cfg.hiftModelPath =
      readOptionalString(configurationParams, env, "cosyvoiceHiftModelPath");
  cfg.s3tokModelPath =
      readOptionalString(configurationParams, env, "cosyvoiceS3tokModelPath");
  cfg.campplusModelPath = readOptionalString(
      configurationParams, env, "cosyvoiceCampplusModelPath");
  cfg.referenceAudio =
      readOptionalString(configurationParams, env, "referenceAudio");
  cfg.promptText = readOptionalString(configurationParams, env, "promptText");
  cfg.voice = readOptionalString(configurationParams, env, "voice");
  cfg.instruct = readOptionalString(configurationParams, env, "instruct");
  {
    auto lang = readOptionalString(configurationParams, env, "language");
    if (!lang.empty())
      cfg.language = std::move(lang);
  }
  cfg.seed = readOptionalInt(configurationParams, env, "seed");
  cfg.threads = readOptionalInt(configurationParams, env, "threads");
  cfg.nGpuLayers = readOptionalInt(configurationParams, env, "nGpuLayers");
  cfg.useGpu = readOptionalBool(configurationParams, env, "useGPU");
  cfg.outputSampleRate =
      readOptionalInt(configurationParams, env, "outputSampleRate");
  cfg.cfmSteps = readOptionalInt(configurationParams, env, "cfmSteps");
  cfg.streamChunkTokens =
      readOptionalInt(configurationParams, env, "streamChunkTokens");
  cfg.streamFirstChunkTokens =
      readOptionalInt(configurationParams, env, "streamFirstChunkTokens");
  cfg.streamLeftContextTokens =
      readOptionalInt(configurationParams, env, "streamLeftContextTokens");
  cfg.backendsDir = readOptionalString(configurationParams, env, "backendsDir");
  cfg.enhancerGgufPath =
      readOptionalString(configurationParams, env, "lavasrEnhancerPath");
  cfg.denoiserGgufPath =
      readOptionalString(configurationParams, env, "lavasrDenoiserPath");
  return cfg;
}
}

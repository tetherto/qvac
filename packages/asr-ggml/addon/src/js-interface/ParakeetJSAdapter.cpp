#include "JSAdapter.hpp"

#include <optional>
#include <string>

#include "inference-addon-cpp/JsUtils.hpp"
#include "inference-addon-cpp/Logger.hpp"

namespace qvac_lib_infer_parakeet {

using namespace qvac_lib_inference_addon_cpp;

namespace {

void readInt(js::Object& obj, js_env_t* env, const char* name, int& target) {
  if (auto value = obj.getOptionalPropertyAs<js::Number, int32_t>(env, name)) {
    target = *value;
  }
}

void readBool(js::Object& obj, js_env_t* env, const char* name, bool& target) {
  if (auto value = obj.getOptionalPropertyAs<js::Boolean, bool>(env, name)) {
    target = *value;
  }
}

void readString(
    js::Object& obj, js_env_t* env, const char* name, std::string& target) {
  if (auto value =
          obj.getOptionalPropertyAs<js::String, std::string>(env, name)) {
    target = *value;
  }
}

} // namespace

auto JSAdapter::loadFromJSObject(js::Object jsObject, js_env_t* env)
    -> ParakeetConfig {
  ParakeetConfig config;

  readString(jsObject, env, "modelPath", config.modelPath);
  readString(jsObject, env, "path", config.modelPath);
  readInt(jsObject, env, "maxThreads", config.maxThreads);
  readBool(jsObject, env, "useGPU", config.useGPU);
  readInt(jsObject, env, "sampleRate", config.sampleRate);
  readInt(jsObject, env, "channels", config.channels);
  readBool(jsObject, env, "captionEnabled", config.captionEnabled);
  readBool(jsObject, env, "timestampsEnabled", config.timestampsEnabled);
  readInt(jsObject, env, "seed", config.seed);

  // Streaming mode; unspecified fields keep ParakeetConfig's defaults.
  readBool(jsObject, env, "streaming", config.streaming);
  readInt(jsObject, env, "streamingChunkMs", config.streamingChunkMs);
  readInt(jsObject, env, "streamingHistoryMs", config.streamingHistoryMs);
  readBool(
      jsObject, env, "streamingEmitPartials", config.streamingEmitPartials);
  readBool(jsObject, env, "streamingEnergyVad", config.streamingEnergyVad);
  readInt(
      jsObject, env, "streamingLeftContextMs", config.streamingLeftContextMs);
  readInt(
      jsObject,
      env,
      "streamingRightLookaheadMs",
      config.streamingRightLookaheadMs);

  // AOSC (v2.1+ Sortformer only); ignored for v1/v2/non-Sortformer engines.
  readBool(
      jsObject, env, "streamingSpkCacheEnable", config.streamingSpkCacheEnable);
  readInt(jsObject, env, "streamingSpkCacheLen", config.streamingSpkCacheLen);
  readInt(jsObject, env, "streamingFifoLen", config.streamingFifoLen);
  readInt(
      jsObject,
      env,
      "streamingChunkLeftContextMs",
      config.streamingChunkLeftContextMs);
  readInt(
      jsObject,
      env,
      "streamingChunkRightContextMs",
      config.streamingChunkRightContextMs);
  readInt(
      jsObject,
      env,
      "streamingSpkCacheUpdatePeriod",
      config.streamingSpkCacheUpdatePeriod);

  // Dynamic-backend loading; empty -> leave the existing setting alone.
  readString(jsObject, env, "backendsDir", config.backendsDir);
  readString(jsObject, env, "openclCacheDir", config.openclCacheDir);

  auto innerConfigOpt = jsObject.getOptionalProperty<js::Object>(env, "config");
  if (innerConfigOpt.has_value()) {
    loadModelParams(innerConfigOpt.value(), env, config);
  }

  return config;
}

auto JSAdapter::loadModelParams(
    js::Object modelParamsObj, js_env_t* env, ParakeetConfig& parakeetConfig)
    -> ParakeetConfig {
  readInt(modelParamsObj, env, "maxThreads", parakeetConfig.maxThreads);
  readBool(modelParamsObj, env, "useGPU", parakeetConfig.useGPU);
  return parakeetConfig;
}

auto JSAdapter::loadAudioParams(
    js::Object audioParamsObj, js_env_t* env, ParakeetConfig& parakeetConfig)
    -> ParakeetConfig {
  readInt(audioParamsObj, env, "sampleRate", parakeetConfig.sampleRate);
  readInt(audioParamsObj, env, "channels", parakeetConfig.channels);
  return parakeetConfig;
}

} // namespace qvac_lib_infer_parakeet

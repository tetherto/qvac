#include "JSAdapter.hpp"

#include <optional>
#include <sstream>
#include <string>
#include <utility>

#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/JsUtils.hpp"

namespace qvac::asrggml {

namespace js = qvac_lib_inference_addon_cpp::js;
namespace general_error = qvac_errors::general_error;

using parakeet::ParakeetConfig;
using whisper::JSValueVariant;
using whisper::WhisperConfig;

namespace {

std::string
readOptionalString(js::Object& obj, js_env_t* env, const char* name) {
  auto value = obj.getOptionalPropertyAs<js::String, std::string>(env, name);
  return value.value_or(std::string{});
}

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

// Nested `configurationParams.config` override block (parakeet).
void readInnerModelParams(
    js::Object& modelParamsObj, js_env_t* env, ParakeetConfig& config) {
  readInt(modelParamsObj, env, "maxThreads", config.maxThreads);
  readBool(modelParamsObj, env, "useGPU", config.useGPU);
}

auto getPropertyNames(js_env_t* env, js::Object object) -> js::Array {
  js_value_t* propertyNames;
  JS(js_get_property_names(env, object, &propertyNames));
  return js::Array::fromValue(propertyNames);
}

auto getValueType(js_env_t* env, js_value_t* value) -> js_value_type_t {
  js_value_type_t valueType;
  JS(js_typeof(env, value, &valueType));
  return valueType;
}

template <typename T>
void addConfigParam(
    std::map<std::string, JSValueVariant>& cfg, std::string&& key, T&& value) {
  if (auto e = cfg.try_emplace(std::move(key), std::forward<T>(value));
      !e.second) {
    std::ostringstream oss;
    oss << "key '" << key << "' already exists";
    throw std::runtime_error{oss.str()};
  }
}

} // namespace

EngineType
JSAdapter::readEngineType(js::Object configurationParams, js_env_t* env) {
  const std::string explicitType =
      readOptionalString(configurationParams, env, "engineType");
  if (explicitType == "whisper") {
    return EngineType::Whisper;
  }
  if (explicitType == "parakeet") {
    return EngineType::Parakeet;
  }
  if (!explicitType.empty()) {
    throw qvac_errors::StatusError(
        general_error::InvalidArgument,
        "engineType must be 'whisper' or 'parakeet' (got '" + explicitType +
            "')");
  }

  // Inference fallback (convenience for direct-binding consumers only; the
  // JS drivers always pass engineType). Parakeet's config is the only one
  // with a top-level model path key; whisper's model arrives via
  // loadWeights and its config nests under whisperConfig / contextParams /
  // miscConfig.
  if (!readOptionalString(configurationParams, env, "modelPath").empty()) {
    return EngineType::Parakeet;
  }
  if (!readOptionalString(configurationParams, env, "path").empty()) {
    return EngineType::Parakeet;
  }

  return EngineType::Whisper; // default engine
}

auto JSAdapter::buildWhisperConfig(js::Object jsObject, js_env_t* env)
    -> WhisperConfig {

  // just a struct
  WhisperConfig config;

  // first handle whisper config params
  auto whisperConfigObj =
      jsObject.getOptionalProperty<js::Object>(env, "whisperConfig");
  if (whisperConfigObj.has_value()) {

    // just map the whisperMainCfg stuff directly.
    loadMap(whisperConfigObj.value(), env, config.whisperMainCfg);

    // then subnested see if vad params exist
    auto vadParamsObj =
        whisperConfigObj.value().getOptionalProperty<js::Object>(
            env, "vadParams");
    if (vadParamsObj.has_value()) {
      loadVadParams(vadParamsObj.value(), env, config);
    }
  }

  auto miscParamsObj =
      jsObject.getOptionalProperty<js::Object>(env, "miscConfig");
  if (miscParamsObj.has_value()) {
    loadMiscParams(miscParamsObj.value(), env, config);
  }

  // finally handle context params
  auto contextParamsObj =
      jsObject.getOptionalProperty<js::Object>(env, "contextParams");
  if (contextParamsObj.has_value()) {
    loadContextParams(contextParamsObj.value(), env, config);
  }

  // Top-level `configurationParams.backendsDir`. Read directly because
  // `loadContextParams` would route it through `WHISPER_CONTEXT_HANDLERS`
  // and throw on an unrecognised key. Consumed only on Android.
  auto backendsDirJs =
      jsObject.getOptionalProperty<js::String>(env, "backendsDir");
  if (backendsDirJs.has_value()) {
    config.backendsDir = backendsDirJs.value().as<std::string>(env);
  }

  return config;
}

auto JSAdapter::buildParakeetConfig(js::Object jsObject, js_env_t* env)
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
    readInnerModelParams(innerConfigOpt.value(), env, config);
  }

  return config;
}

void JSAdapter::loadMiscParams(
    js::Object miscParamsObj, js_env_t* env, WhisperConfig& whisperConfig) {
  loadMap(miscParamsObj, env, whisperConfig.miscConfig);
}

void JSAdapter::loadContextParams(
    js::Object contextParamsObj, js_env_t* env, WhisperConfig& whisperConfig) {
  loadMap(contextParamsObj, env, whisperConfig.whisperContextCfg);
}

void JSAdapter::loadVadParams(
    js::Object vadParamsObj, js_env_t* env, WhisperConfig& whisperConfig) {
  loadMap(vadParamsObj, env, whisperConfig.vadCfg);
}

void JSAdapter::loadMap(
    js::Object jsObject, js_env_t* env,
    std::map<std::string, JSValueVariant>& output) {
  // Get all property names from the JS object
  auto names = getPropertyNames(env, jsObject);
  auto namesSize = names.size(env);
  // Iterate through the names array and get the values
  for (auto i = 0; i < namesSize; ++i) {
    auto key = names.get<js::String>(env, i);
    auto value = jsObject.getProperty(env, key);
    switch (getValueType(env, value)) {
    // addConfigParam throws if the key already exists
    case js_boolean:
      addConfigParam(
          output,
          key.as<std::string>(env),
          js::Boolean::fromValue(value).as<bool>(env));
      break;
    case js_number:
      addConfigParam(
          output,
          key.as<std::string>(env),
          js::Number::fromValue(value).as<double>(env));
      break;
    case js_string:
      addConfigParam(
          output,
          key.as<std::string>(env),
          js::String::fromValue(value).as<std::string>(env));
      break;
    case js_object:
      continue;
    case js_function:
      continue;
    default:
      throw qvac_errors::StatusError(
          general_error::InvalidArgument,
          "Invalid type for key: " + key.as<std::string>(env) +
              " is not supported");
    }
  }
}

} // namespace qvac::asrggml

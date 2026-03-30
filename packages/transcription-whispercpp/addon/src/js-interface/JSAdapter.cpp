#include "JSAdapter.hpp"

#include <format>
#include <sstream>

#include <whisper.h>

#include "model-interface/whisper.cpp/WhisperConfig.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"

using namespace qvac_lib_inference_addon_cpp::js;

namespace qvac_lib_inference_addon_whisper {
auto JSAdapter::loadFromJSObject(Object jsObject, js_env_t* env)
    -> WhisperConfig {

  // just a struct
  WhisperConfig config;

  // first handle whisper config params
  auto whisperConfigObj =
      jsObject.getOptionalProperty<Object>(env, "whisperConfig");
  if (whisperConfigObj.has_value()) {

    // just map the whisperMainCfg stuff directly.
    loadMap(whisperConfigObj.value(), env, config.whisperMainCfg);

    // then subnested see if vad params exist
    auto vadParamsObj =
        whisperConfigObj.value().getOptionalProperty<Object>(env, "vadParams");
    if (vadParamsObj.has_value()) {
      loadVadParams(vadParamsObj.value(), env, config);
    }
  }

  auto miscParamsObj = jsObject.getOptionalProperty<Object>(env, "miscConfig");
  if (miscParamsObj.has_value()) {
    loadMiscParams(miscParamsObj.value(), env, config);
  }

  // finally handle context params
  auto contextParamsObj =
      jsObject.getOptionalProperty<Object>(env, "contextParams");
  if (contextParamsObj.has_value()) {
    loadContextParams(contextParamsObj.value(), env, config);
  }

  return config;
}

auto JSAdapter::loadMiscParams(
    Object miscParamsObj, js_env_t* env, WhisperConfig& whisperConfig)
    -> WhisperConfig {
  loadMap(miscParamsObj, env, whisperConfig.miscConfig);
  return whisperConfig;
}

auto JSAdapter::loadContextParams(
    Object contextParamsObj, js_env_t* env, WhisperConfig& whisperConfig)
    -> WhisperConfig {
  loadMap(contextParamsObj, env, whisperConfig.whisperContextCfg);
  return whisperConfig;
}

auto JSAdapter::loadVadParams(
    Object vadParamsObj, js_env_t* env, WhisperConfig& whisperConfig)
    -> WhisperConfig {
  loadMap(vadParamsObj, env, whisperConfig.vadCfg);
  return whisperConfig;
}

auto getPropertyNames(js_env_t* env, Object object) -> Array {
  js_value_t* propertyNames;
  JS(js_get_property_names(env, object, &propertyNames));
  return Array::fromValue(propertyNames);
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

void JSAdapter::loadMap(
    Object jsObject, js_env_t* env,
    std::map<std::string, JSValueVariant>& output) {
  // Get all property names from the JS object
  auto names = getPropertyNames(env, jsObject);
  auto namesSize = names.size(env);
  // Iterate through the names array and get the values
  for (auto i = 0; i < namesSize; ++i) {
    auto key = names.get<String>(env, i);
    auto value = jsObject.getProperty(env, key);
    switch (getValueType(env, value)) {
    // addConfigParam throws if the key already exists
    case js_boolean:
      addConfigParam(
          output,
          key.as<std::string>(env),
          Boolean::fromValue(value).as<bool>(env));
      break;
    case js_number:
      addConfigParam(
          output,
          key.as<std::string>(env),
          Number::fromValue(value).as<double>(env));
      break;
    case js_string:
      addConfigParam(
          output,
          key.as<std::string>(env),
          String::fromValue(value).as<std::string>(env));
      break;
    case js_object:
      continue;
    case js_function:
      continue;
    default:
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Invalid type for key: " + key.as<std::string>(env) +
              " is not supported");
    }
  }
}
} // namespace qvac_lib_inference_addon_whisper

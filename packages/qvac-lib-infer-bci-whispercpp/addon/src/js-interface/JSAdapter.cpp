#include "JSAdapter.hpp"

#include <sstream>
#include <string>
#include <variant>

#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>

using namespace qvac_lib_inference_addon_cpp::js;

namespace qvac_lib_inference_addon_bci {

namespace {

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

} // namespace

void JSAdapter::loadMap(
    Object jsObject, js_env_t* env,
    std::map<std::string, JSValueVariant>& output) {

  auto names = getPropertyNames(env, jsObject);
  auto namesSize = names.size(env);
  for (auto i = 0; i < namesSize; ++i) {
    auto key = names.get<String>(env, i);
    auto value = jsObject.getProperty(env, key);
    switch (getValueType(env, value)) {
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

BCIConfig JSAdapter::loadFromJSObject(Object jsObject, js_env_t* env) {
  BCIConfig config;

  auto whisperConfigObj =
      jsObject.getOptionalProperty<Object>(env, "whisperConfig");
  if (whisperConfigObj.has_value()) {
    loadMap(whisperConfigObj.value(), env, config.whisperMainCfg);
  }

  auto contextParamsObj =
      jsObject.getOptionalProperty<Object>(env, "contextParams");
  if (contextParamsObj.has_value()) {
    loadContextParams(contextParamsObj.value(), env, config);
  }

  auto miscConfigObj =
      jsObject.getOptionalProperty<Object>(env, "miscConfig");
  if (miscConfigObj.has_value()) {
    loadMiscParams(miscConfigObj.value(), env, config);
  }

  auto bciConfigObj =
      jsObject.getOptionalProperty<Object>(env, "bciConfig");
  if (bciConfigObj.has_value()) {
    loadBCIParams(bciConfigObj.value(), env, config);
  }

  return config;
}

void JSAdapter::loadContextParams(
    Object contextParamsObj, js_env_t* env, BCIConfig& config) {
  loadMap(contextParamsObj, env, config.whisperContextCfg);
}

void JSAdapter::loadMiscParams(
    Object miscParamsObj, js_env_t* env, BCIConfig& config) {
  loadMap(miscParamsObj, env, config.miscConfig);
}

void JSAdapter::loadBCIParams(
    Object bciParamsObj, js_env_t* env, BCIConfig& config) {
  loadMap(bciParamsObj, env, config.bciConfig);
}

} // namespace qvac_lib_inference_addon_bci

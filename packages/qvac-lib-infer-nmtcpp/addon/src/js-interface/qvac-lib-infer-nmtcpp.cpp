#include "qvac-lib-infer-nmtcpp.hpp"

#include <algorithm>
#include <cctype>
#include <climits>
#include <cmath>
#include <iostream>
#include <memory>
#include <span>
#include <unordered_map>
#include <variant>
#include <vector>

#include "addon/Addon.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"

namespace js = qvac_lib_inference_addon_cpp::js;
using JsIfMarian = qvac_lib_inference_addon_cpp::JsInterface<qvac_lib_inference_addon_mlc_marian::Addon>;

static std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
getConfigMap(
    js_env_t* env, js::Object configurationParams, const char* propertyName) {
  auto configOpt =
      configurationParams.getOptionalProperty<js::Object>(env, propertyName);
  std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
      configMap;

  if (!configOpt.has_value()) {
    return configMap;
  }

  auto config = configOpt.value();
  js_value_t* configKeys;
  JS(js_get_property_names(env, config, &configKeys));

  js::Array configKeysArray(env, configKeys);
  uint32_t configKeysSz = configKeysArray.size(env);

  while (configKeysSz > 0) {
    configKeysSz--;
    js_value_t* key;
    JS(js_get_element(env, configKeys, configKeysSz, &key));
    auto value = config.getProperty(env, key);

    std::string keyString = js::String::fromValue(key).as<std::string>(env);
    std::transform(
        keyString.begin(),
        keyString.end(),
        keyString.begin(),
        [](unsigned char c) { return std::tolower(c); });
    if (js::is<js::Int32>(env, value) || js::is<js::Uint32>(env, value) ||
        js::is<js::BigInt>(env, value)) {
      auto jsNumber = js::Number{env, value};
      configMap[keyString] = jsNumber.as<int64_t>(env);
    } else if (js::is<js::Number>(env, value)) {
      auto jsNumber = js::Number{env, value};
      configMap[keyString] = jsNumber.as<double>(env);
    } else if (js::is<js::String>(env, value)) {
      auto jsString = js::String::fromValue(value);
      configMap[keyString] = jsString.as<std::string>(env);
    } else {
      std::string msg = "Expected numeric or string value for config key '" + keyString +
                        "' but got a different type";
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument, msg);
    }
  }

  return configMap;
}

// Specialization of JsInterface methods for Marian addon
namespace qvac_lib_inference_addon_cpp {

template <> js_value_t *JsIfMarian::createInstance(js_env_t *env, js_callback_info_t *info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 4) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Incorrect number of parameters. Expected 4 parameters");
  }
  if (!js::is<js::Function>(env, args[2])) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Expected output callback as function");
  }
  auto configurationParams = js::Object{env, args[1]};
  auto modelPathJs = configurationParams.getOptionalProperty<js::String>(env, "path");
  std::string modelPath = modelPathJs ? modelPathJs.value().as<std::string>(env) : "";

  auto config = getConfigMap(env, configurationParams, "config");

  // Extract use_gpu boolean parameter (defaults to false if not specified)
  bool useGpu = false;
  auto useGpuOpt = configurationParams.getOptionalProperty<js::Boolean>(env, "use_gpu");
  if (useGpuOpt.has_value()) {
    useGpu = useGpuOpt.value().as<bool>(env);
  }

  std::scoped_lock instancesLock{instancesMtx_};
  auto& handle = instances_.emplace_back(
      std::make_unique<qvac_lib_inference_addon_mlc_marian::Addon>(
          env, std::cref(modelPath), config, useGpu, args[0], args[2], args[3]));

  return js::External::create(env, handle.get());
}
JSCATCH

template <> js_value_t *JsIfMarian::load(js_env_t *env, js_callback_info_t *info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 2 parameters");
  }
  auto &instance = getInstance(env, args[0]);
  auto configurationParams = js::Object{env, args[1]};
  std::optional<js::String> modelPath =
      configurationParams.getOptionalProperty<js::String>(env, "path");
  auto config = getConfigMap(env, configurationParams, "config");
  instance.load(
      modelPath ? modelPath.value().as<std::string>(env) : "", config);

  return nullptr;
}
JSCATCH

template <> js_value_t *JsIfMarian::reload(js_env_t *env, js_callback_info_t *info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 2 parameters");
  }
  auto &instance = getInstance(env, args[0]);
  auto configurationParams = js::Object{env, args[1]};
  std::optional<js::String> modelPath =
      configurationParams.getOptionalProperty<js::String>(env, "path");
  auto config = getConfigMap(env, configurationParams, "config");
  instance.reload(
      modelPath ? modelPath.value().as<std::string>(env) : "", config);

  return nullptr;
}
JSCATCH

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_inference_addon_mlc_marian {

js_value_t *createInstance(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::createInstance(env, info);
}

js_value_t *unload(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::unload(env, info);
}

js_value_t *load(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::load(env, info);
}

js_value_t *reload(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::reload(env, info);
}

js_value_t* loadWeights(js_env_t* /*env*/, js_callback_info_t* /*info*/) {
  throw std::logic_error{"loadWeights not supported"};
}

js_value_t* unloadWeights(js_env_t* /*env*/, js_callback_info_t* /*info*/) {
  throw std::logic_error{"unloadWeights not supported"};
}

js_value_t *activate(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::activate(env, info);
}

js_value_t *append(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::append(env, info);
}

js_value_t *status(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::status(env, info);
}

js_value_t *pause(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::pause(env, info);
}

js_value_t *stop(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::stop(env, info);
}

js_value_t *cancel(js_env_t *env, js_callback_info_t *info) {
  return JsIfMarian::cancel(env, info);
}

js_value_t *destroyInstance(js_env_t *env, js_callback_info_t *info) {
  // Unregister model from static map before destroying addon
  auto args = js::getArguments(env, info);
  if (!args.empty()) {
    auto handle = js::External(env, args[0]).as<void*>(env);
    qvac_lib_inference_addon_cpp::unregisterModelForAddon(handle);
  }
  return JsIfMarian::destroyInstance(env, info);
}

js_value_t* setLogger(js_env_t* env, js_callback_info_t* info) {
  return JsIfMarian::setLogger(env, info);
}

js_value_t* releaseLogger(js_env_t* env, js_callback_info_t* info) {
  return JsIfMarian::releaseLogger(env, info);
}

js_value_t* processBatch(js_env_t* env, js_callback_info_t* info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Expected 2 parameters: instance handle and array of texts");
  }

  // Get addon handle pointer and retrieve model
  auto handle = js::External(env, args[0]).as<void*>(env);
  auto* model = qvac_lib_inference_addon_cpp::getModelForAddon(handle);
  if (!model) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Invalid handle or model not found");
  }

  // Get array of texts from JS
  if (!js::is<js::Array>(env, args[1])) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Second parameter must be an array of strings");
  }

  js::Array textsArray(env, args[1]);
  uint32_t arraySize = textsArray.size(env);

  std::vector<std::string> texts;
  texts.reserve(arraySize);

  for (uint32_t i = 0; i < arraySize; ++i) {
    js_value_t* element;
    if (js_get_element(env, args[1], i, &element) != 0) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Failed to get element at index " + std::to_string(i));
    }
    if (!js::is<js::String>(env, element)) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Array element at index " + std::to_string(i) + " is not a string");
    }
    texts.push_back(js::String::fromValue(element).as<std::string>(env));
  }

  // Call processBatch on the model
  std::vector<std::string> results = model->processBatch(texts);

  // Create JS array for results
  js_value_t* resultArray;
  if (js_create_array_with_length(env, results.size(), &resultArray) != 0) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError,
        "Failed to create result array");
  }

  for (size_t i = 0; i < results.size(); ++i) {
    js_value_t* str;
    if (js_create_string_utf8(
            env,
            reinterpret_cast<const utf8_t*>(results[i].c_str()),
            results[i].size(),
            &str) != 0) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "Failed to create result string at index " + std::to_string(i));
    }
    if (js_set_element(env, resultArray, static_cast<uint32_t>(i), str) != 0) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "Failed to set result at index " + std::to_string(i));
    }
  }

  return resultArray;
}
JSCATCH

} // namespace qvac_lib_inference_addon_mlc_marian

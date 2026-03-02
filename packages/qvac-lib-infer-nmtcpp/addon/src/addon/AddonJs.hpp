#pragma once

#include <algorithm>
#include <iterator>
#include <vector>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "model-interface/TranslationModel.hpp"

namespace {
using namespace qvac_lib_inference_addon_cpp;
static std::unordered_map<
    std::string, std::variant<double, int64_t, std::string>>
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
      std::string msg = "Expected numeric or string value for config key '" +
                        keyString + "' but got a different type";
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument, msg);
    }
  }

  return configMap;
}

} // namespace
namespace qvac_lib_inference_addon_marian {

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);

  auto configurationParamsJs = args.getJsObject(1, "config");
  auto config = getConfigMap(env, configurationParamsJs, "config");

  auto modelPathJs =
      configurationParamsJs.getOptionalProperty<js::String>(env, "path");
  std::string modelPath =
      modelPathJs ? modelPathJs.value().as<std::string>(env) : "";
  auto model =
      std::make_unique<qvac_lib_inference_addon_marian::TranslationModel>(
          modelPath);

  model->setConfig(config);
  model->load();
  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;

  outHandlers.add(make_shared<out_handl::JsStringOutputHandler>());
  outHandlers.add(make_shared<out_handl::JsStringArrayOutputHandler>());

  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon =
      std::make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);

  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto [type, jsInput] = JsInterface::getInput(args);

  std::any anyInput;
  if (type == "text") {
    anyInput = js::String(env, jsInput).as<std::string>(env);
  } else if (type == "sequences") {
    auto vectorOfJsValues =
        js::Array(env, jsInput).as<std::vector<js_value_t*>>(env);
    std::vector<std::string> inputSequence;
    inputSequence.reserve(vectorOfJsValues.size());

    std::ranges::transform(
        vectorOfJsValues,
        std::back_inserter(inputSequence),
        [&env](js_value_t* const string_value) {
          return js::String(env, string_value).as<std::string>(env);
        });

    anyInput = inputSequence;
  }

  if (!anyInput.has_value()) {
    throw StatusError(general_error::InvalidArgument, type);
  }

  return instance.runJob(std::move(anyInput));
}
JSCATCH

} // namespace qvac_lib_inference_addon_marian

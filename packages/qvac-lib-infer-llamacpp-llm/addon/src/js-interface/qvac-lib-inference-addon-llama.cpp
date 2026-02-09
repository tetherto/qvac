#include "qvac-lib-inference-addon-llama.hpp"

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/Addon.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
using JsIfLlama = qvac_lib_inference_addon_cpp::JsInterface<
    qvac_lib_inference_addon_llama::Addon>;
using JsLogger = qvac_lib_inference_addon_cpp::logger::JsLogger;
// Specialization of JsInterface methods
namespace qvac_lib_inference_addon_cpp {
template <>
js_value_t*
JsIfLlama::createInstance(js_env_t* env, js_callback_info_t* info) try {
  auto args = js::getArguments(env, info);
  constexpr size_t kExpectedFiveArgs = 5;
  if (args.size() != 4 && args.size() != kExpectedFiveArgs) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Incorrect number of parameters. Expected 4 or 5 parameters");
  }
  if (!js::is<js::Function>(env, args[2])) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Expected output callback as function");
  }
  auto configurationParams = js::Object{env, args[1]};
  auto modelPath = configurationParams.getProperty<js::String>(env, "path")
                       .as<std::string>(env);
  auto projectionPath =
      configurationParams.getProperty<js::String>(env, "projectionPath")
          .as<std::string>(env);
  bool result = false;
  auto key = js::String::create(env, "config");
  JS(js_has_property(env, configurationParams, key, &result));
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap = getConfigFilemap(env, configurationParams);
  std::scoped_lock lock{instancesMtx_};
  if (args.size() == kExpectedFiveArgs) {
    if (!js::is<js::Object>(env, args[4])) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Expected an object for finetuning parameters.");
    }
    if (!qvac_lib_inference_addon_llama::Addon::supportsFinetuning()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Addon does not support finetuning.");
    }
    auto finetuningParametersObj = js::Object{env, args[4]};
    FinetuningParameters finetuningArgs(env, finetuningParametersObj);
    auto& handle = instances_.emplace_back(
        std::make_unique<qvac_lib_inference_addon_llama::Addon>(
            env,
            std::cref(modelPath),
            std::ref(configFilemap),
            std::cref(finetuningArgs),
            args[0],
            args[2],
            args[3]));
    return js::External::create(env, handle.get());
  }
  auto& handle = instances_.emplace_back(
      std::make_unique<qvac_lib_inference_addon_llama::Addon>(
          env,
          std::cref(modelPath),
          std::cref(projectionPath),
          std::ref(configFilemap),
          args[0],
          args[2],
          args[3]));
  return js::External::create(env, handle.get());
}
JSCATCH
template <>
js_value_t* JsIfLlama::append(js_env_t* env, js_callback_info_t* info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 2 parameters");
  }
  auto toAppend = js::Object{env, args[1]};
  auto type =
      toAppend.getProperty<js::String>(env, "type").as<std::string>(env);
  auto& instance = getInstance(env, args[0]);
  if (type == "end of job") {
    return js::Number::create(env, instance.endOfJob());
  }
  if (type == "text") {
    int priority = getAppendPriority(env, toAppend);
    auto input =
        toAppend.getProperty<js::String>(env, "input").as<std::string>(env);
    return js::Number::create(env, instance.append(priority, input));
  }
  if (type == "media") {
    int priority = getAppendPriority(env, toAppend);
    auto input = toAppend.getProperty<js::TypedArray<uint8_t>>(env, "input")
                     .as<std::vector<uint8_t>>(env);
    return js::Number::create(env, instance.append(priority, input));
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument, "Invalid type");
}
JSCATCH
} // namespace qvac_lib_inference_addon_cpp
namespace qvac_lib_inference_addon_llama
{
  js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) { 
    return JsIfLlama::createInstance(env, info); 
  } 
  
  js_value_t* loadWeights(js_env_t* env, js_callback_info_t* info) { 
    return JsIfLlama::loadWeights(env, info);
  } 
  
  js_value_t* activate(js_env_t* env, js_callback_info_t* info) { 
    return JsIfLlama::activate(env, info); 
  } 
  
  js_value_t* append(js_env_t* env, js_callback_info_t* info) { 
    return JsIfLlama::append(env, info); 
  } 
  
  js_value_t* status(js_env_t* env, js_callback_info_t* info) { 
    return JsIfLlama::status(env, info); 
  } 
  
  js_value_t* pause(js_env_t* env, js_callback_info_t* info) { 
    return JsIfLlama::pause(env, info); 
  } 
  
  js_value_t* stop(js_env_t* env, js_callback_info_t* info) { 
    return JsIfLlama::stop(env, info); 
  } 
  
  js_value_t* cancel(js_env_t* env, js_callback_info_t* info) { 
    return JsIfLlama::cancel(env, info); 
  } 
  
  js_value_t* destroyInstance(js_env_t* env, js_callback_info_t* info) {
    return JsIfLlama::destroyInstance(env, info);
  }
  auto setLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
    return JsIfLlama::setLogger(env, info);
  }
  auto releaseLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
    return JsIfLlama::releaseLogger(env, info);
  }
  } // namespace qvac_lib_inference_addon_llama

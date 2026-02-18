#include "qvac-lib-infer-parakeet.hpp"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <span>
#include <vector>

#include "JSAdapter.hpp"
#include "addon/Addon.hpp"
#include "js.h"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace js = qvac_lib_inference_addon_cpp::js;
using JsIfParakeet = qvac_lib_inference_addon_cpp::JsInterface<
    qvac_lib_infer_parakeet::Addon>;

using qvac_lib_inference_addon_cpp::logger::JsLogger;
using JSAdapter = qvac_lib_infer_parakeet::JSAdapter;

// Helper function to create ParakeetConfig from JS parameters using JSAdapter
auto createParakeetConfig(js_env_t* env, const js::Object& configurationParams)
    -> qvac_lib_infer_parakeet::ParakeetConfig {
  JSAdapter adapter;
  return adapter.loadFromJSObject(configurationParams, env);
}

// Redefinition of functions in the interface for specific behavior of Parakeet
namespace qvac_lib_inference_addon_cpp {

// NOLINTNEXTLINE(modernize-use-trailing-return-type)
template <>
auto JsIfParakeet::createInstance(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* // NOLINT(modernize-use-trailing-return-type)
    try {
  auto args = js::getArguments(env, info);
  if (args.size() != 4) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 4 parameters");
  }
  if (!js::is<js::Function>(env, args[2])) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Expected output callback as function");
  }

  auto configurationParams = js::Object{env, args[1]};

  // Get enableStats from the top level config
  bool enableStats = false;
  auto enableStatsJS =
      configurationParams.getOptionalProperty<js::Boolean>(env, "enableStats");
  if (enableStatsJS.has_value()) {
    enableStats = enableStatsJS.value().as<bool>(env);
  }

  // Create ParakeetConfig from JS parameters
  qvac_lib_infer_parakeet::ParakeetConfig parakeetConfig =
      createParakeetConfig(env, configurationParams);

  std::scoped_lock lockGuard{instancesMtx_};
  auto& instance = instances_.emplace_back(
      std::make_unique<qvac_lib_infer_parakeet::Addon>(
          env, args[0], args[2], args[3], parakeetConfig, enableStats));

  return js::External::create(env, instance.get());
}
JSCATCH

// NOLINTNEXTLINE(modernize-use-trailing-return-type)
template <>
auto JsIfParakeet::append(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* // NOLINT(modernize-use-trailing-return-type)
    try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 2 parameters");
  }

  auto& instance = getInstance(env, args[0]);
  auto configurationParams = js::Object{env, args[1]};

  // Check the type field
  auto typeOpt = configurationParams.getOptionalProperty<js::String>(env, "type");
  std::string type = typeOpt.has_value() ? typeOpt.value().as<std::string>(env) : "audio";

  // Handle "end of job" type
  if (type == "end of job") {
    return js::Number::create(env, instance.endOfJob());
  }

  // Handle audio type
  if (type == "audio") {
    auto priority = getAppendPriority(env, configurationParams);

    // Get audio data
    auto data = configurationParams.getProperty(env, "data");
    void* dataPtr = nullptr;
    size_t length = 0;
    JS(js_get_arraybuffer_info(env, data, &dataPtr, &length));

    const float* floatData = static_cast<const float*>(dataPtr);
    size_t numSamples = length / sizeof(float);

    std::span<const float> audioSpan(floatData, numSamples);
    uint32_t jobId = instance.append(priority, audioSpan);

    return js::Number::create(env, jobId);
  }

  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument, "Invalid type: " + type);
}
JSCATCH

// NOLINTNEXTLINE(modernize-use-trailing-return-type)
template <>
auto JsIfParakeet::load(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* // NOLINT(modernize-use-trailing-return-type)
    try {
  auto args = js::getArguments(env, info);
  if (args.size() < 1) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 1 parameter");
  }

  auto& instance = getInstance(env, args[0]);
  
  // For Parakeet, load() triggers ONNX session initialization
  // using weights that were already loaded via loadWeights()
  std::unordered_map<std::string, std::string> emptyFilemap;
  instance.load(emptyFilemap);

  return nullptr;
}
JSCATCH

// NOLINTNEXTLINE(modernize-use-trailing-return-type)
template <>
auto JsIfParakeet::reload(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* // NOLINT(modernize-use-trailing-return-type)
    try {
  auto args = js::getArguments(env, info);
  if (args.size() < 1) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 1 parameter");
  }

  auto& instance = getInstance(env, args[0]);

  if (args.size() > 1) {
    auto configurationParams = js::Object{env, args[1]};
    qvac_lib_infer_parakeet::ParakeetConfig parakeetConfig =
        createParakeetConfig(env, configurationParams);
    instance.reload(parakeetConfig);
  }

  return nullptr;
}
JSCATCH

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_infer_parakeet {

// Define module exports
auto createInstance(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::createInstance(env, info);
}

auto unload(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::unload(env, info);
}

auto load(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::load(env, info);
}

auto reload(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::reload(env, info);
}

auto loadWeights(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::loadWeights(env, info);
}

auto unloadWeights(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::unloadWeights(env, info);
}

auto activate(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::activate(env, info);
}

auto append(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::append(env, info);
}

auto status(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::status(env, info);
}

auto pause(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::pause(env, info);
}

auto stop(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::stop(env, info);
}

auto cancel(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::cancel(env, info);
}

auto destroyInstance(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::destroyInstance(env, info);
}

auto setLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::setLogger(env, info);
}

auto releaseLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfParakeet::releaseLogger(env, info);
}

} // namespace qvac_lib_infer_parakeet

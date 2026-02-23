#include "JSAdapter.hpp"

#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_infer_parakeet {

using namespace qvac_lib_inference_addon_cpp;

auto JSAdapter::loadFromJSObject(js::Object jsObject, js_env_t* env)
    -> ParakeetConfig {
  ParakeetConfig config;

  // Get modelPath (required)
  auto modelPathOpt = jsObject.getOptionalProperty<js::String>(env, "modelPath");
  if (modelPathOpt.has_value()) {
    config.modelPath = modelPathOpt.value().as<std::string>(env);
  }

  // Also try "path" key for compatibility with JsInterface
  auto pathOpt = jsObject.getOptionalProperty<js::String>(env, "path");
  if (pathOpt.has_value()) {
    config.modelPath = pathOpt.value().as<std::string>(env);
  }

  // Get modelType
  auto modelTypeOpt = jsObject.getOptionalProperty<js::String>(env, "modelType");
  if (modelTypeOpt.has_value()) {
    std::string typeStr = modelTypeOpt.value().as<std::string>(env);
    if (typeStr == "ctc") {
      config.modelType = ModelType::CTC;
    } else if (typeStr == "tdt") {
      config.modelType = ModelType::TDT;
    } else if (typeStr == "eou") {
      config.modelType = ModelType::EOU;
    } else if (typeStr == "sortformer") {
      config.modelType = ModelType::SORTFORMER;
    }
  }

  // Get maxThreads
  auto threadsOpt = jsObject.getOptionalProperty<js::Number>(env, "maxThreads");
  if (threadsOpt.has_value()) {
    config.maxThreads = threadsOpt.value().as<int32_t>(env);
  }

  // Get useGPU
  auto gpuOpt = jsObject.getOptionalProperty<js::Boolean>(env, "useGPU");
  if (gpuOpt.has_value()) {
    config.useGPU = gpuOpt.value().as<bool>(env);
  }

  // Get sampleRate
  auto sampleRateOpt = jsObject.getOptionalProperty<js::Number>(env, "sampleRate");
  if (sampleRateOpt.has_value()) {
    config.sampleRate = sampleRateOpt.value().as<int32_t>(env);
  }

  // Get channels
  auto channelsOpt = jsObject.getOptionalProperty<js::Number>(env, "channels");
  if (channelsOpt.has_value()) {
    config.channels = channelsOpt.value().as<int32_t>(env);
  }

  // Get captionEnabled
  auto captionOpt =
      jsObject.getOptionalProperty<js::Boolean>(env, "captionEnabled");
  if (captionOpt.has_value()) {
    config.captionEnabled = captionOpt.value().as<bool>(env);
  }

  // Get timestampsEnabled
  auto timestampsOpt =
      jsObject.getOptionalProperty<js::Boolean>(env, "timestampsEnabled");
  if (timestampsOpt.has_value()) {
    config.timestampsEnabled = timestampsOpt.value().as<bool>(env);
  }

  // Get seed
  auto seedOpt = jsObject.getOptionalProperty<js::Number>(env, "seed");
  if (seedOpt.has_value()) {
    config.seed = seedOpt.value().as<int32_t>(env);
  }

  // Get individual file paths
  auto encoderPathOpt =
      jsObject.getOptionalProperty<js::String>(env, "encoderPath");
  if (encoderPathOpt.has_value()) {
    config.encoderPath = encoderPathOpt.value().as<std::string>(env);
  }
  auto encoderDataPathOpt =
      jsObject.getOptionalProperty<js::String>(env, "encoderDataPath");
  if (encoderDataPathOpt.has_value()) {
    config.encoderDataPath = encoderDataPathOpt.value().as<std::string>(env);
  }
  auto decoderPathOpt =
      jsObject.getOptionalProperty<js::String>(env, "decoderPath");
  if (decoderPathOpt.has_value()) {
    config.decoderPath = decoderPathOpt.value().as<std::string>(env);
  }
  auto vocabPathOpt =
      jsObject.getOptionalProperty<js::String>(env, "vocabPath");
  if (vocabPathOpt.has_value()) {
    config.vocabPath = vocabPathOpt.value().as<std::string>(env);
  }
  auto preprocessorPathOpt =
      jsObject.getOptionalProperty<js::String>(env, "preprocessorPath");
  if (preprocessorPathOpt.has_value()) {
    config.preprocessorPath = preprocessorPathOpt.value().as<std::string>(env);
  }

  // Check for nested config object
  auto innerConfigOpt = jsObject.getOptionalProperty<js::Object>(env, "config");
  if (innerConfigOpt.has_value()) {
    loadModelParams(innerConfigOpt.value(), env, config);
  }

  return config;
}

auto JSAdapter::loadModelParams(js::Object modelParamsObj, js_env_t *env,
                                ParakeetConfig &parakeetConfig)
    -> ParakeetConfig {
  // Get maxThreads from nested config
  auto threadsOpt = modelParamsObj.getOptionalProperty<js::Number>(env, "maxThreads");
  if (threadsOpt.has_value()) {
    parakeetConfig.maxThreads = threadsOpt.value().as<int32_t>(env);
  }

  // Get useGPU from nested config
  auto gpuOpt = modelParamsObj.getOptionalProperty<js::Boolean>(env, "useGPU");
  if (gpuOpt.has_value()) {
    parakeetConfig.useGPU = gpuOpt.value().as<bool>(env);
  }

  return parakeetConfig;
}

auto JSAdapter::loadAudioParams(
    js::Object audioParamsObj, js_env_t* env, ParakeetConfig& parakeetConfig)
    -> ParakeetConfig {
  // Get sampleRate
  auto sampleRateOpt = audioParamsObj.getOptionalProperty<js::Number>(env, "sampleRate");
  if (sampleRateOpt.has_value()) {
    parakeetConfig.sampleRate = sampleRateOpt.value().as<int32_t>(env);
  }

  // Get channels
  auto channelsOpt = audioParamsObj.getOptionalProperty<js::Number>(env, "channels");
  if (channelsOpt.has_value()) {
    parakeetConfig.channels = channelsOpt.value().as<int32_t>(env);
  }

  return parakeetConfig;
}

void JSAdapter::loadMap(
    js::Object jsObject, js_env_t* env,
    std::map<std::string, JSValueVariant>& output) {
  // Get property names
  js_value_t* propNames = nullptr;
  JS(js_get_property_names(env, jsObject, &propNames));

  uint32_t length = 0;
  JS(js_get_array_length(env, propNames, &length));

  for (uint32_t i = 0; i < length; ++i) {
    js_value_t* propName = nullptr;
    JS(js_get_element(env, propNames, i, &propName));

    auto key = js::String(env, propName).as<std::string>(env);
    auto value = jsObject.getProperty(env, key.c_str());

    js_value_type_t type;
    JS(js_typeof(env, value, &type));

    switch (type) {
    case js_boolean: {
      bool boolVal = false;
      JS(js_get_value_bool(env, value, &boolVal));
      output[key] = boolVal;
      break;
    }
    case js_number: {
      double numVal = 0.0;
      JS(js_get_value_double(env, value, &numVal));
      output[key] = numVal;
      break;
    }
    case js_string: {
      output[key] = js::String(env, value).as<std::string>(env);
      break;
    }
    default:
      // Skip unsupported types
      break;
    }
  }
}

} // namespace qvac_lib_infer_parakeet

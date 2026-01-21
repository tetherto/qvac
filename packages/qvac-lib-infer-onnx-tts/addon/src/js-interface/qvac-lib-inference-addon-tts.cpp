#include "qvac-lib-inference-addon-tts.hpp"

#include "src/addon/Addon.hpp"
#include "src/addon/TTSErrors.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"

#include <js.h>
#include <cstdio>
#include <string>
#include <unordered_map>

namespace js = qvac_lib_inference_addon_cpp::js;
using JsIfTTS = qvac_lib_inference_addon_cpp::JsInterface<qvac_lib_inference_addon_tts::Addon>;

// Helper function to extract TTS configuration from JS object
static std::unordered_map<std::string, std::string> getTTSConfigMap(js_env_t* env, js::Object configurationParams) {
  std::unordered_map<std::string, std::string> configMap;
  
  // Extract TTS-specific configuration
  auto modelPathOpt = configurationParams.getOptionalProperty<js::String>(env, "modelPath");
  if (modelPathOpt.has_value()) {
    configMap["modelPath"] = modelPathOpt.value().as<std::string>(env);
  }
  
  auto languageOpt = configurationParams.getOptionalProperty<js::String>(env, "language");
  if (languageOpt.has_value()) {
    configMap["language"] = languageOpt.value().as<std::string>(env);
  } else {
    configMap["language"] = "en";
  }
  
  auto eSpeakDataPathOpt = configurationParams.getOptionalProperty<js::String>(env, "eSpeakDataPath");
  if (eSpeakDataPathOpt.has_value()) {
    configMap["eSpeakDataPath"] = eSpeakDataPathOpt.value().as<std::string>(env);
  }
  
  auto configJsonPathOpt = configurationParams.getOptionalProperty<js::String>(env, "configJsonPath");
  if (configJsonPathOpt.has_value()) {
    configMap["configJsonPath"] = configJsonPathOpt.value().as<std::string>(env);
  }
  
  auto useGPUOpt = configurationParams.getOptionalProperty<js::Boolean>(env, "useGPU");
  if (useGPUOpt.has_value()) {
    configMap["useGPU"] = useGPUOpt.value().as<bool>(env) ? "true" : "false";
  }

  auto tashkeelModelDirOpt =
      configurationParams.getOptionalProperty<js::String>(env,
                                                          "tashkeelModelDir");
  if (tashkeelModelDirOpt.has_value()) {
    configMap["tashkeelModelDir"] =
        tashkeelModelDirOpt.value().as<std::string>(env);
  }

  return configMap;
}

// Specialization of JsInterface methods for TTS addon
namespace qvac_lib_inference_addon_cpp {

template <> 
js_value_t *JsIfTTS::createInstance(js_env_t *env, js_callback_info_t *info) try {  
  auto args = js::getArguments(env, info);
  if (args.size() != 4) {
    throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "Incorrect number of parameters. Expected 4 parameters");
  }
  if (!js::is<js::Function>(env, args[2])) {
    throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "Expected output callback as function");
  }

  auto configurationParams = js::Object{env, args[1]};  
  auto configMap = getTTSConfigMap(env, configurationParams);

  std::scoped_lock lk{JsIfTTS::instancesMtx_};
  auto &handle = JsIfTTS::instances_.emplace_back(
    std::make_unique<qvac_lib_inference_addon_tts::Addon>(
      env, configMap, args[0], args[2], args[3]));

  return js::External::create(env, handle.get());
}
JSCATCH

template <> 
js_value_t* JsIfTTS::load(js_env_t* env, js_callback_info_t* info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "Incorrect number of parameters. Expected 2 parameters");
  }
  auto& instance = getInstance(env, args[0]);
  auto configurationParams = js::Object{env, args[1]};
  std::unordered_map<std::string, std::string> configFilemap = getTTSConfigMap(env, configurationParams);
  instance.load(configFilemap);

  return nullptr;
} JSCATCH

template <> 
js_value_t* JsIfTTS::reload(js_env_t* env, js_callback_info_t* info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "Incorrect number of parameters. Expected 2 parameters");
  }
  auto& instance = getInstance(env, args[0]);
  auto configurationParams = js::Object{env, args[1]};
  std::unordered_map<std::string, std::string> configFilemap = getTTSConfigMap(env, configurationParams);
  instance.reload(configFilemap);

  return nullptr;
} JSCATCH

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_inference_addon_tts {

// Export functions that delegate to JsInterface
js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) {
  return JsIfTTS::createInstance(env, info);
}

js_value_t *unload(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::unload(env, info);
}

js_value_t *load(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::load(env, info);
}

js_value_t *reload(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::reload(env, info);
}

js_value_t *loadWeights(js_env_t *env, js_callback_info_t *info) {
  throw qvac_errors::createTTSError(qvac_errors::tts_error::InvalidAPI, "loadWeights not supported");
}

js_value_t *unloadWeights(js_env_t *env, js_callback_info_t *info) {
  throw qvac_errors::createTTSError(qvac_errors::tts_error::InvalidAPI, "unloadWeights not supported");
}

js_value_t* activate(js_env_t* env, js_callback_info_t* info) {
  return JsIfTTS::activate(env, info);
}

js_value_t* append(js_env_t* env, js_callback_info_t* info) {
  return JsIfTTS::append(env, info);
}

js_value_t* status(js_env_t* env, js_callback_info_t* info) {
  return JsIfTTS::status(env, info);
}

js_value_t* pause(js_env_t* env, js_callback_info_t* info) {
  return JsIfTTS::pause(env, info);
}

js_value_t* stop(js_env_t* env, js_callback_info_t* info) {
  return JsIfTTS::stop(env, info);
}

js_value_t* cancel(js_env_t* env, js_callback_info_t* info) {
  return JsIfTTS::cancel(env, info);
}

js_value_t* destroyInstance(js_env_t* env, js_callback_info_t* info) {
  return JsIfTTS::destroyInstance(env, info);
}

auto setLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfTTS::setLogger(env, info);
}
auto releaseLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfTTS::releaseLogger(env, info);
}

} // namespace qvac_lib_inference_addon_tts

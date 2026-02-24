#include "qvac-lib-inference-addon-tts.hpp"

#include <cstdio>
#include <string>
#include <unordered_map>

#include <js.h>

#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "src/addon/Addon.hpp"
#include "src/addon/TTSErrors.hpp"

namespace js = qvac_lib_inference_addon_cpp::js;
using JsIfTTS = qvac_lib_inference_addon_cpp::JsInterface<
    qvac_lib_inference_addon_tts::Addon>;

// Helper function to extract TTS configuration from JS object
static std::unordered_map<std::string, std::string>
getTTSConfigMap(js_env_t *env, js::Object configurationParams) {
  std::unordered_map<std::string, std::string> configMap;

  auto languageOpt =
      configurationParams.getOptionalProperty<js::String>(env, "language");
  if (languageOpt.has_value()) {
    configMap["language"] = languageOpt.value().as<std::string>(env);
  }

  auto useGPUOpt =
      configurationParams.getOptionalProperty<js::Boolean>(env, "useGPU");
  if (useGPUOpt.has_value()) {
    configMap["useGPU"] = useGPUOpt.value().as<bool>(env) ? "true" : "false";
  }

  auto tokenizerPathOpt =
      configurationParams.getOptionalProperty<js::String>(env, "tokenizerPath");
  if (tokenizerPathOpt.has_value()) {
    configMap["tokenizerPath"] = tokenizerPathOpt.value().as<std::string>(env);
  }

  auto speechEncoderPathOpt =
      configurationParams.getOptionalProperty<js::String>(env,
                                                          "speechEncoderPath");
  if (speechEncoderPathOpt.has_value()) {
    configMap["speechEncoderPath"] =
        speechEncoderPathOpt.value().as<std::string>(env);
  }

  auto embedTokensPathOpt = configurationParams.getOptionalProperty<js::String>(
      env, "embedTokensPath");
  if (embedTokensPathOpt.has_value()) {
    configMap["embedTokensPath"] =
        embedTokensPathOpt.value().as<std::string>(env);
  }

  auto conditionalDecoderPathOpt =
      configurationParams.getOptionalProperty<js::String>(
          env, "conditionalDecoderPath");
  if (conditionalDecoderPathOpt.has_value()) {
    configMap["conditionalDecoderPath"] =
        conditionalDecoderPathOpt.value().as<std::string>(env);
  }

  auto languageModelPathOpt =
      configurationParams.getOptionalProperty<js::String>(env,
                                                          "languageModelPath");
  if (languageModelPathOpt.has_value()) {
    configMap["languageModelPath"] =
        languageModelPathOpt.value().as<std::string>(env);
  }

  // Supertonic engine options
  auto modelDirOpt =
      configurationParams.getOptionalProperty<js::String>(env, "modelDir");
  if (modelDirOpt.has_value()) {
    configMap["modelDir"] = modelDirOpt.value().as<std::string>(env);
  }
  auto textEncoderPathOpt =
      configurationParams.getOptionalProperty<js::String>(env, "textEncoderPath");
  if (textEncoderPathOpt.has_value()) {
    configMap["textEncoderPath"] =
        textEncoderPathOpt.value().as<std::string>(env);
  }
  auto latentDenoiserPathOpt =
      configurationParams.getOptionalProperty<js::String>(env,
                                                          "latentDenoiserPath");
  if (latentDenoiserPathOpt.has_value()) {
    configMap["latentDenoiserPath"] =
        latentDenoiserPathOpt.value().as<std::string>(env);
  }
  auto voiceDecoderPathOpt =
      configurationParams.getOptionalProperty<js::String>(env,
                                                          "voiceDecoderPath");
  if (voiceDecoderPathOpt.has_value()) {
    configMap["voiceDecoderPath"] =
        voiceDecoderPathOpt.value().as<std::string>(env);
  }
  auto voicesDirOpt =
      configurationParams.getOptionalProperty<js::String>(env, "voicesDir");
  if (voicesDirOpt.has_value()) {
    configMap["voicesDir"] = voicesDirOpt.value().as<std::string>(env);
  }
  auto voiceNameOpt =
      configurationParams.getOptionalProperty<js::String>(env, "voiceName");
  if (voiceNameOpt.has_value()) {
    configMap["voiceName"] = voiceNameOpt.value().as<std::string>(env);
  }
  auto speedOpt =
      configurationParams.getOptionalProperty<js::String>(env, "speed");
  if (speedOpt.has_value()) {
    configMap["speed"] = speedOpt.value().as<std::string>(env);
  }
  auto numInferenceStepsOpt =
      configurationParams.getOptionalProperty<js::String>(env,
                                                          "numInferenceSteps");
  if (numInferenceStepsOpt.has_value()) {
    configMap["numInferenceSteps"] =
        numInferenceStepsOpt.value().as<std::string>(env);
  }

  auto lazySessionLoadingOpt = configurationParams.getOptionalProperty<js::Boolean>(env, "lazySessionLoading");
  if (lazySessionLoadingOpt.has_value()) {
    configMap["lazySessionLoading"] = lazySessionLoadingOpt.value().as<bool>(env) ? "true" : "false";
  }

  return configMap;
}

// Helper function to extract Float32Array for reference audio (Chatterbox voice
// cloning)
static std::vector<float> getReferenceAudio(js_env_t *env,
                                            js::Object configurationParams) {
  auto refAudioOpt =
      configurationParams.getOptionalProperty<js::TypedArray<float>>(
          env, "referenceAudio");
  if (refAudioOpt.has_value()) {
    return refAudioOpt.value().as<std::vector<float>>(env);
  }
  return {};
}

// Specialization of JsInterface methods for TTS addon
namespace qvac_lib_inference_addon_cpp {

template <>
js_value_t *JsIfTTS::createInstance(js_env_t *env,
                                    js_callback_info_t *info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 4) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Incorrect number of parameters. Expected 4 parameters");
  }
  if (!js::is<js::Function>(env, args[2])) {
    throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument,
                                   "Expected output callback as function");
  }

  auto configurationParams = js::Object{env, args[1]};
  auto configMap = getTTSConfigMap(env, configurationParams);

  // Extract reference audio (Float32Array) for Chatterbox voice cloning
  auto referenceAudio = getReferenceAudio(env, configurationParams);

  std::scoped_lock lk{JsIfTTS::instancesMtx_};
  auto &handle = JsIfTTS::instances_.emplace_back(
      std::make_unique<qvac_lib_inference_addon_tts::Addon>(
          env, configMap, referenceAudio, args[0], args[2], args[3]));

  return js::External::create(env, handle.get());
}
JSCATCH

template <>
js_value_t *JsIfTTS::load(js_env_t *env, js_callback_info_t *info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Incorrect number of parameters. Expected 2 parameters");
  }
  auto &instance = getInstance(env, args[0]);
  auto configurationParams = js::Object{env, args[1]};
  std::unordered_map<std::string, std::string> configFilemap =
      getTTSConfigMap(env, configurationParams);
  instance.load(configFilemap);

  return nullptr;
}
JSCATCH

template <>
js_value_t *JsIfTTS::reload(js_env_t *env, js_callback_info_t *info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Incorrect number of parameters. Expected 2 parameters");
  }
  auto &instance = getInstance(env, args[0]);
  auto configurationParams = js::Object{env, args[1]};
  std::unordered_map<std::string, std::string> configFilemap =
      getTTSConfigMap(env, configurationParams);
  instance.reload(configFilemap);

  return nullptr;
}
JSCATCH

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_inference_addon_tts {

// Export functions that delegate to JsInterface
js_value_t *createInstance(js_env_t *env, js_callback_info_t *info) {
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
  throw qvac_errors::createTTSError(qvac_errors::tts_error::InvalidAPI,
                                    "loadWeights not supported");
}

js_value_t *unloadWeights(js_env_t *env, js_callback_info_t *info) {
  throw qvac_errors::createTTSError(qvac_errors::tts_error::InvalidAPI,
                                    "unloadWeights not supported");
}

js_value_t *activate(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::activate(env, info);
}

js_value_t *append(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::append(env, info);
}

js_value_t *status(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::status(env, info);
}

js_value_t *pause(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::pause(env, info);
}

js_value_t *stop(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::stop(env, info);
}

js_value_t *cancel(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::cancel(env, info);
}

js_value_t *destroyInstance(js_env_t *env, js_callback_info_t *info) {
  return JsIfTTS::destroyInstance(env, info);
}

auto setLogger(js_env_t *env, js_callback_info_t *info) -> js_value_t * {
  return JsIfTTS::setLogger(env, info);
}
auto releaseLogger(js_env_t *env, js_callback_info_t *info) -> js_value_t * {
  return JsIfTTS::releaseLogger(env, info);
}

} // namespace qvac_lib_inference_addon_tts

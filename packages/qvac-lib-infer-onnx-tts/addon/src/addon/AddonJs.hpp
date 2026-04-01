#pragma once

#include <memory>
#include <span>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <js.h>
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "src/model-interface/TTSModel.hpp"

namespace qvac_lib_inference_addon_tts {

namespace js = qvac_lib_inference_addon_cpp::js;
using qvac::ttslib::addon_model::TTSModel;

inline std::unordered_map<std::string, std::string>
getTTSConfigMap(js_env_t *env, js::Object configurationParams) {
  std::unordered_map<std::string, std::string> configMap;

  auto addString = [&](const char *key) {
    auto value = configurationParams.getOptionalProperty<js::String>(env, key);
    if (value.has_value()) {
      configMap[key] = value.value().as<std::string>(env);
    }
  };

  addString("language");
  addString("tokenizerPath");
  addString("speechEncoderPath");
  addString("embedTokensPath");
  addString("conditionalDecoderPath");
  addString("languageModelPath");

  addString("modelDir");
  addString("textEncoderPath");
  addString("unicodeIndexerPath");
  addString("ttsConfigPath");
  addString("durationPredictorPath");
  addString("vectorEstimatorPath");
  addString("vocoderPath");
  addString("voiceStyleJsonPath");
  addString("voiceName");
  addString("speed");
  addString("numInferenceSteps");

  auto addBool = [&](const char *key) {
    auto value = configurationParams.getOptionalProperty<js::Boolean>(env, key);
    if (value.has_value()) {
      configMap[key] = value.value().as<bool>(env) ? "true" : "false";
    }
  };
  addBool("useGPU");
  addBool("lazySessionLoading");
  addBool("supertonicMultilingual");

  return configMap;
}

inline std::vector<float> getReferenceAudio(
    js_env_t *env, js::Object configurationParams) {
  auto refAudio = configurationParams.getOptionalProperty<js::TypedArray<float>>(
      env, "referenceAudio");
  if (!refAudio.has_value()) {
    return {};
  }
  return refAudio.value().as<std::vector<float>>(env);
}

inline bool hasProperty(js_env_t *env, js::Object object, const char *name) {
  bool result = false;
  JS(js_has_property(env, object, js::String::create(env, name), &result));
  return result;
}

struct JsAudioOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<int16_t>> {
  JsAudioOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<int16_t>>([this](const std::vector<int16_t> &data)
                                      -> js_value_t * {
          auto result = js::Object::create(this->env_);
          std::span<const int16_t> outputSpan(data.data(), data.size());
          auto typedArray = js::TypedArray<int16_t>::create(this->env_, outputSpan);
          result.setProperty(this->env_, "outputArray", typedArray);
          return result;
        }) {}
};

inline js_value_t *createInstance(js_env_t *env, js_callback_info_t *info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  unique_ptr<model::IModel> model = make_unique<TTSModel>(
      getTTSConfigMap(env, configurationParams),
      getReferenceAudio(env, configurationParams));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<JsAudioOutputHandler>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t *runJob(js_env_t *env, js_callback_info_t *info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs &instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto [type, jsInput] = JsInterface::getInput(args);
  auto inputObj = args.getJsObject(1, "inputObj");

  if (type != "text") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  TTSModel::AnyInput modelInput;
  modelInput.text = js::String(env, jsInput).as<std::string>(env);

  if (hasProperty(env, inputObj, "config")) {
    auto runtimeConfig = inputObj.getProperty<js::Object>(env, "config");
    modelInput.config = getTTSConfigMap(env, runtimeConfig);
  }

  return instance.runJob(any(std::move(modelInput)));
}
JSCATCH

} // namespace qvac_lib_inference_addon_tts

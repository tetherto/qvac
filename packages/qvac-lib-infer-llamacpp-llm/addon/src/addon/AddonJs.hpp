#pragma once
#include <functional>
#include <iostream>
#include <memory>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <qvac-lib-inference-addon-cpp/FinetuningParameters.hpp>

#include "model-interface/LlamaModel.hpp"

namespace qvac_lib_inference_addon_llama {

inline LlamaModel* getLlamaModel(qvac_lib_inference_addon_cpp::AddonJs& instance) {
  return static_cast<LlamaModel*>(&instance.addonCpp->model.get());
}

inline std::function<void(const std::string&)> makeQueueOutputCallback(
    qvac_lib_inference_addon_cpp::AddonJs& instance) {
  return [&instance](const std::string& s) {
    instance.addonCpp->outputQueue->queueResult(std::any(s));
  };
}

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  unique_ptr<model::IModel> model = make_unique<LlamaModel>(
      args.getMapEntry(1, "path"),
      args.getMapEntry(1, "projectionPath"),
      args.getSubmap(1, "config"));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<out_handl::JsStringOutputHandler>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      args.get(3, "transitionCb"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  vector<pair<string, js::Object>> inputs = JsInterface::getInputsArray(args);

  LlamaModel::Prompt prompt;
  prompt.outputCallback = makeQueueOutputCallback(instance);

  auto parseText = [&](js::Object& inputObj) {
    if (!prompt.input.empty()) {
      throw StatusError(
          general_error::InvalidArgument, "Only one text input is allowed");
    }
    prompt.input =
        js::String(env, inputObj.getProperty<js::String>(env, "input"))
            .as<std::string>(env);
    prompt.prefill =
        inputObj.getOptionalPropertyAs<js::Boolean, bool>(env, "prefill")
            .value_or(false);
  };

  auto parseMedia = [&](js::Object& inputObj) {
    if (prompt.media.has_value()) {
      throw StatusError(
          general_error::InvalidArgument, "Only one media input is allowed");
    }
    prompt.media =
        js::TypedArray<uint8_t>(
            env, inputObj.getProperty<js::TypedArray<uint8_t>>(env, "content"))
            .as<std::vector<uint8_t>>(env);
  };

  for (auto& input : inputs) {
    if (input.first == "text") {
      parseText(input.second);
    } else if (input.first == "media") {
      parseMedia(input.second);
    } else {
      throw StatusError(
          general_error::InvalidArgument, "Unknown input type: " + input.first);
    }
  }

  if (prompt.input.empty() && !prompt.media.has_value()) {
    throw StatusError(
        general_error::InvalidArgument,
        "At least one of text or media input is required");
  }

  instance.addonCpp->runJob(any(std::move(prompt)));
  return nullptr;
}
JSCATCH

inline js_value_t* cancel(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  LlamaModel* llamaModel = getLlamaModel(instance);
  auto* addonCpp = instance.addonCpp.get();

  return js::JsAsyncTask::run(env, [llamaModel, addonCpp]() {
    if (llamaModel && llamaModel->isFinetuneRunning() && llamaModel->requestPause())
      llamaModel->waitUntilFinetuningPauseComplete();
    else
      addonCpp->cancelJob();
  });
}
JSCATCH

inline js_value_t* finetune(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  LlamaModel* llamaModel = getLlamaModel(instance);
  if (llamaModel == nullptr) {
    throw StatusError(
        general_error::InvalidArgument,
        "Model not available or not a LlamaModel");
  }

  auto paramsOpt = args.tryGetObject<FinetuningParameters>(
      1, "finetuningParams",
      [](js_env_t* e, js::Object& jsObj) { return FinetuningParameters(e, jsObj); });
  if (!paramsOpt.has_value()) {
    throw StatusError(
        general_error::InvalidArgument,
        "Finetuning parameters not provided");
  }

  LlamaModel::Prompt prompt;
  prompt.finetuningParams = *paramsOpt;
  prompt.outputCallback = makeQueueOutputCallback(instance);

  instance.addonCpp->runJob(any(std::move(prompt)));
  return nullptr;
}
JSCATCH

inline js_value_t* activate(js_env_t* env, js_callback_info_t* info) try {
  return qvac_lib_inference_addon_cpp::JsInterface::activate(env, info);
}
JSCATCH

} // namespace qvac_lib_inference_addon_llama

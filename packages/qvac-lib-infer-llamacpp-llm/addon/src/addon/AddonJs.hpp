#pragma once
#include <atomic>
#include <iostream>
#include <memory>
#include <unordered_map>
#include <mutex>
#include <thread>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <qvac-lib-inference-addon-cpp/FinetuningParameters.hpp>

#include "model-interface/LlamaModel.hpp"
#include "FinetuneParamStore.hpp"

namespace qvac_lib_inference_addon_llama {

namespace {
std::mutex g_modelMapMutex;
std::unordered_map<void*, LlamaModel*> g_modelMap;
std::atomic<bool> shouldResumeFromPause{false};
} // namespace

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  unique_ptr<model::IModel> model = make_unique<LlamaModel>(
      args.getMapEntry(1, "path"),
      args.getMapEntry(1, "projectionPath"),
      args.getSubmap(1, "config"));

  LlamaModel* llamaModelPtr = dynamic_cast<LlamaModel*>(model.get());

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<out_handl::JsStringOutputHandler>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      args.get(3, "transitionCb"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  void* addonCppPtr = addon->addonCpp.get();
  if (llamaModelPtr != nullptr && addonCppPtr != nullptr) {
    std::scoped_lock lock{g_modelMapMutex};
    g_modelMap[addonCppPtr] = llamaModelPtr;
  }

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
  prompt.outputCallback = [&](const string& tokenOut) {
    instance.addonCpp->outputQueue->queueResult(any(tokenOut));
  };

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

inline js_value_t* finetune(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  LlamaModel* llamaModel = nullptr;
  {
    std::scoped_lock lock{g_modelMapMutex};
    auto it = g_modelMap.find(instance.addonCpp.get());
    if (it != g_modelMap.end()) {
      llamaModel = it->second;
    }
  }

  if (llamaModel == nullptr) {
    throw StatusError(
        general_error::InvalidArgument,
        "Model not available or not a LlamaModel");
  }

  try {
    js_value_t* arg1 = args.get(1, "finetuningParams");
    if (!js::is<js::Undefined>(env, arg1) && !js::is<js::Null>(env, arg1)) {
      if (!js::is<js::Object>(env, arg1)) {
        throw StatusError(
            general_error::InvalidArgument,
            "Expected finetuning parameters as an object.");
      }
      auto finetuningParametersObj = js::Object{env, arg1};
      FinetuningParameters finetuningArgs(env, finetuningParametersObj);
      qvac_lib_inference_addon_llama_detail::put(
          instance.addonCpp.get(), finetuningArgs);
    }
  } catch (const StatusError& e) {
  }

  FinetuningParameters params;
  bool hasParams = qvac_lib_inference_addon_llama_detail::take(
      instance.addonCpp.get(), params);

  if (!hasParams) {
    throw StatusError(
        general_error::InvalidArgument,
        "Finetuning parameters not provided and not stored");
  }

  qvac_lib_inference_addon_llama_detail::put(
      instance.addonCpp.get(), params);

  auto* outputQueue = instance.addonCpp->outputQueue.get();
  auto enqueueLog = [outputQueue](const string& message) {
    if (outputQueue != nullptr) {
      outputQueue->queueResult(any(message));
    }
  };

  bool allowResume = shouldResumeFromPause.exchange(false);

  std::thread finetuneThread([llamaModel, params, enqueueLog, allowResume]() {
    try {
      llamaModel->finetune(params, enqueueLog, allowResume);
    } catch (const std::exception& e) {
      std::cerr << "[ERROR] Finetuning thread exception: " << e.what() << std::endl;
    }
  });
  finetuneThread.detach();

  return nullptr;
}
JSCATCH

inline js_value_t* pause(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  LlamaModel* llamaModel = nullptr;
  {
    std::scoped_lock lock{g_modelMapMutex};
    auto it = g_modelMap.find(instance.addonCpp.get());
    if (it != g_modelMap.end()) {
      llamaModel = it->second;
    }
  }

  if (llamaModel == nullptr) {
    throw StatusError(
        general_error::InvalidArgument,
        "Model not available or not a LlamaModel");
  }

  bool didPause = llamaModel->requestPause();
  shouldResumeFromPause.store(false);

  if (!didPause) {
    return js::Boolean::create(env, false);
  }
  return js::JsAsyncTask::run(env, [llamaModel]() {
    llamaModel->waitUntilPauseComplete();
  });
}
JSCATCH

inline js_value_t* isFinetuningRunning(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  LlamaModel* llamaModel = nullptr;
  {
    std::scoped_lock lock{g_modelMapMutex};
    auto it = g_modelMap.find(instance.addonCpp.get());
    if (it != g_modelMap.end()) {
      llamaModel = it->second;
    }
  }

  bool running = false;
  if (llamaModel != nullptr) {
    auto* checkpointState = llamaModel->getCurrentCheckpointState();
    if (checkpointState != nullptr && checkpointState->isFinetuning.load()) {
      running = true;
    }
  }

  return js::Boolean::create(env, running);
}
JSCATCH

inline js_value_t* activate(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  LlamaModel* llamaModel = nullptr;
  {
    std::scoped_lock lock{g_modelMapMutex};
    auto it = g_modelMap.find(instance.addonCpp.get());
    if (it != g_modelMap.end()) {
      llamaModel = it->second;
    }
  }

  bool shouldResume = false;
  if (llamaModel != nullptr) {
    auto* checkpointState = llamaModel->getCurrentCheckpointState();
    if (checkpointState != nullptr && checkpointState->isPaused.load()) {
      shouldResume = true;
    }
  }

  if (shouldResume && llamaModel != nullptr) {
    FinetuningParameters params;
    bool hasParams = qvac_lib_inference_addon_llama_detail::take(
        instance.addonCpp.get(), params);
    
    if (hasParams) {
      qvac_lib_inference_addon_llama_detail::put(
          instance.addonCpp.get(), params);
      
      llamaModel->clearPauseRequest();
      shouldResumeFromPause.store(true);
      
      return finetune(env, info);
    }
  }

  return JsInterface::activate(env, info);
}
JSCATCH

} // namespace qvac_lib_inference_addon_llama

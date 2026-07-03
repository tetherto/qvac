#pragma once

#include <any>
#include <memory>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <js.h>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "js-interface/JSAdapter.hpp"
#include "model-interface/chatterbox/ChatterboxModel.hpp"
#include "model-interface/supertonic/SupertonicModel.hpp"

namespace qvac::ttsggml::addon_js {

namespace js = qvac_lib_inference_addon_cpp::js;

using chatterbox::ChatterboxModel;
using supertonic::SupertonicModel;

struct JsAudioOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<int16_t>> {
  explicit JsAudioOutputHandler(int sampleRate)
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<int16_t>>(
            [this, sampleRate](
                const std::vector<int16_t>& data) -> js_value_t* {
              auto result = js::Object::create(this->env_);
              std::span<const int16_t> outputSpan(data.data(), data.size());
              auto typedArray =
                  js::TypedArray<int16_t>::create(this->env_, outputSpan);
              result.setProperty(this->env_, "outputArray", typedArray);
              result.setProperty(
                  this->env_, "sampleRate",
                  js::Number::create(this->env_, sampleRate));
              return result;
            }) {}
};

struct StreamingPcmChunk {
  std::vector<int16_t> pcm;
  int chunkIndex = 0;
  bool isLast = false;
};

struct JsStreamingPcmHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          StreamingPcmChunk> {
  explicit JsStreamingPcmHandler(int sampleRate)
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            StreamingPcmChunk>(
            [this, sampleRate](const StreamingPcmChunk& chunk) -> js_value_t* {
              auto result = js::Object::create(this->env_);
              std::span<const int16_t> outputSpan(chunk.pcm.data(), chunk.pcm.size());
              auto typedArray =
                  js::TypedArray<int16_t>::create(this->env_, outputSpan);
              result.setProperty(this->env_, "outputArray", typedArray);
              result.setProperty(
                  this->env_, "sampleRate",
                  js::Number::create(this->env_, sampleRate));
              result.setProperty(
                  this->env_, "chunkIndex",
                  js::Number::create(this->env_, chunk.chunkIndex));
              result.setProperty(
                  this->env_, "isLast",
                  js::Boolean::create(this->env_, chunk.isLast));
              return result;
            }) {}
};

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  JSAdapter adapter;
  const EngineType engineType = adapter.readEngineType(configurationParams, env);

  unique_ptr<model::IModel> model;
  int sampleRate = 24000;

  // The output sample rate is baked into the JS output handlers at instance
  // creation. Final-rate precedence:
  //   1. outputSampleRate (engine resamples, or the addon resamples after the
  //      enhancer) — always the final emitted rate when set;
  //   2. 48000 when the LavaSR enhancer is active (it always emits 48 kHz);
  //   3. the engine's native rate.
  constexpr int kLavasrEnhancedSampleRate = 48000;

  if (engineType == EngineType::Supertonic) {
    auto cfg = adapter.buildSupertonicConfig(configurationParams, env);
    const bool enhanced = !cfg.enhancerGgufPath.empty();
    const int outSr = cfg.outputSampleRate.value_or(0);
    auto stm = make_unique<SupertonicModel>(std::move(cfg));
    sampleRate =
        outSr > 0 ? outSr
                  : (enhanced ? kLavasrEnhancedSampleRate : stm->sampleRate());
    model = std::move(stm);
  } else {
    auto cfg = adapter.buildChatterboxConfig(configurationParams, env);
    const bool enhanced = !cfg.enhancerGgufPath.empty();
    const int outSr = cfg.outputSampleRate.value_or(0);
    sampleRate =
        outSr > 0 ? outSr : (enhanced ? kLavasrEnhancedSampleRate : 24000);
    model = make_unique<ChatterboxModel>(std::move(cfg));
  }

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<JsAudioOutputHandler>(sampleRate));
  outHandlers.add(make_shared<JsStreamingPcmHandler>(sampleRate));
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env, args.get(0, "jsHandle"), args.getFunction(2, "outputCallback"),
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
  auto [type, jsInput] = JsInterface::getInput(args);

  if (type != "text") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  if (auto* st = dynamic_cast<SupertonicModel*>(&instance.addonCpp->model.get())) {
    SupertonicModel::AnyInput modelInput;
    modelInput.text = js::String(env, jsInput).as<std::string>(env);
    return instance.runJob(std::any(std::move(modelInput)));
  }

  ChatterboxModel::AnyInput modelInput;
  modelInput.text = js::String(env, jsInput).as<std::string>(env);

  auto outputQueue = instance.addonCpp->outputQueue;
  modelInput.chunkCallback = [outputQueue](
      std::vector<int16_t>&& pcm, int chunkIndex, bool isLast) {
    StreamingPcmChunk chunk{std::move(pcm), chunkIndex, isLast};
    outputQueue->queueResult(std::any(std::move(chunk)));
  };

  return instance.runJob(std::any(std::move(modelInput)));
}
JSCATCH

// Async wrapper around AddonCpp::activate() so the deferred GGUF parse
// (ChatterboxModel / SupertonicModel construct without loading; the
// real load happens in waitForLoadInitialization() via IModelAsyncLoad)
// runs on a JsAsyncTask worker thread instead of stalling the JS event
// loop.  Replaces the default sync JsInterface::activate registration in
// binding.cpp.
inline js_value_t* activate(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  return js::JsAsyncTask::run(
      env, [addonCpp = instance.addonCpp]() { addonCpp->activate(); });
}
JSCATCH

inline js_value_t* reload(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configurationParams = args.getJsObject(1, "configurationParams");
  JSAdapter adapter;

  if (auto* st = dynamic_cast<SupertonicModel*>(&instance.addonCpp->model.get())) {
    auto newCfg = adapter.buildSupertonicConfig(configurationParams, env);
    return js::JsAsyncTask::run(
        env,
        [addonCpp = instance.addonCpp, newCfg = std::move(newCfg)]() mutable {
          auto* stm =
              dynamic_cast<SupertonicModel*>(&addonCpp->model.get());
          if (stm == nullptr) {
            throw qvac_errors::StatusError(
                qvac_errors::general_error::InternalError,
                "reload: model is not a SupertonicModel");
          }
          stm->setConfig(std::move(newCfg));
          stm->reload();
        });
  }

  auto newCfg = adapter.buildChatterboxConfig(configurationParams, env);
  return js::JsAsyncTask::run(
      env,
      [addonCpp = instance.addonCpp, newCfg = std::move(newCfg)]() mutable {
        auto* chatterbox =
            dynamic_cast<ChatterboxModel*>(&addonCpp->model.get());
        if (chatterbox == nullptr) {
          throw qvac_errors::StatusError(
              qvac_errors::general_error::InternalError,
              "reload: model is not a ChatterboxModel");
        }
        chatterbox->setConfig(std::move(newCfg));
        chatterbox->reload();
      });
}
JSCATCH

}

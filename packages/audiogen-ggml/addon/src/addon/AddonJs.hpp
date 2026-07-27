#pragma once

#include <any>
#include <memory>
#include <optional>
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
#include "model-interface/acestep/AcestepModel.hpp"

namespace qvac::audiogenggml::addon_js {

namespace js = qvac_lib_inference_addon_cpp::js;

using acestep::AcestepModel;

// Emits the generated track as interleaved stereo Int16 + sample rate, mirror
// of ttsggml::JsAudioOutputHandler. The rate/channels are sourced from the model
// (which reads them from the engine's decode result) rather than hardcoded, so
// the values reported alongside the PCM always match the runtime stats. PCM is
// emitted once, after generate() completes, so the model already holds the real
// engine values by the time this runs.
struct JsAudioOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<int16_t>> {
  explicit JsAudioOutputHandler(const AcestepModel* model)
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<int16_t>>(
            [this, model](
                const std::vector<int16_t>& data) -> js_value_t* {
              auto result = js::Object::create(this->env_);
              std::span<const int16_t> outputSpan(data.data(), data.size());
              auto typedArray =
                  js::TypedArray<int16_t>::create(this->env_, outputSpan);
              result.setProperty(this->env_, "outputArray", typedArray);
              result.setProperty(
                  this->env_, "sampleRate",
                  js::Number::create(this->env_, model->sampleRate()));
              result.setProperty(
                  this->env_, "channels",
                  js::Number::create(this->env_, model->channels()));
              return result;
            }) {}
};

// Emits a mid-generation progress tick as { progressStage, progressStep,
// progressTotal }. The JS side (plugin sink) distinguishes it from PCM/stats by
// the presence of `progressTotal`.
struct JsProgressOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          acestep::AcestepProgress> {
  JsProgressOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            acestep::AcestepProgress>(
            [this](const acestep::AcestepProgress& p) -> js_value_t* {
              auto result = js::Object::create(this->env_);
              result.setProperty(
                  this->env_, "progressStage",
                  js::String::create(this->env_, p.stage));
              result.setProperty(
                  this->env_, "progressStep",
                  js::Number::create(this->env_, p.step));
              result.setProperty(
                  this->env_, "progressTotal",
                  js::Number::create(this->env_, p.total));
              return result;
            }) {}
};

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  JSAdapter adapter;
  auto cfg = adapter.buildAcestepConfig(configurationParams, env);

  auto model = make_unique<AcestepModel>(std::move(cfg));
  AcestepModel* modelPtr = model.get();

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<JsAudioOutputHandler>(modelPtr));
  outHandlers.add(make_shared<JsProgressOutputHandler>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env, args.get(0, "jsHandle"), args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  // Route per-step engine progress into the output queue so it reaches JS via
  // the same output callback as PCM/stats. The model runs on the job worker
  // thread; OutputQueue::queueResult is thread-safe (locks + uv_async_send).
  auto outputQueue = addon->addonCpp->outputQueue;
  modelPtr->setProgressSink([outputQueue](const acestep::AcestepProgress& p) {
    outputQueue->queueResult(std::any(p));
  });

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto [type, jsInput] = JsInterface::getInput(args);

  if (type != "text") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  // The caption is the primary text input; lyrics/seed/language/bpm/keyscale/
  // timesignature/duration are read as optional per-call overrides from the
  // same job object the framework hands us at arg index 1.
  auto jobObj = args.getJsObject(1, "inputObj");
  auto optStr = [&](const char* key) -> std::optional<std::string> {
    return jobObj.getOptionalPropertyAs<js::String, std::string>(env, key);
  };
  auto optNum = [&](const char* key) -> std::optional<double> {
    js_value_t* raw = jobObj.getProperty(env, key);
    if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
      return std::nullopt;
    }
    if (js::is<js::Number>(env, raw)) {
      return js::Number::fromValue(raw).as<double>(env);
    }
    return std::nullopt;
  };

  AcestepModel::AnyInput modelInput;
  modelInput.caption = js::String(env, jsInput).as<std::string>(env);
  if (auto v = optStr("lyrics")) modelInput.lyrics = *v;
  if (auto v = optStr("vocalLanguage")) modelInput.vocalLanguage = *v;
  if (auto v = optStr("keyscale")) modelInput.keyscale = *v;
  if (auto v = optStr("timesignature")) modelInput.timesignature = *v;
  if (auto v = optNum("seed")) modelInput.seed = static_cast<long long>(*v);
  if (auto v = optNum("bpm")) modelInput.bpm = static_cast<int>(*v);
  if (auto v = optNum("duration")) modelInput.duration = static_cast<float>(*v);
  return instance.runJob(std::any(std::move(modelInput)));
}
JSCATCH

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
  auto newCfg = adapter.buildAcestepConfig(configurationParams, env);

  return js::JsAsyncTask::run(
      env,
      [addonCpp = instance.addonCpp, newCfg = std::move(newCfg)]() mutable {
        auto* m = dynamic_cast<AcestepModel*>(&addonCpp->model.get());
        if (m == nullptr) {
          throw qvac_errors::StatusError(
              qvac_errors::general_error::InternalError,
              "reload: model is not an AcestepModel");
        }
        m->setConfig(std::move(newCfg));
        m->reload();
      });
}
JSCATCH

}  // namespace qvac::audiogenggml::addon_js

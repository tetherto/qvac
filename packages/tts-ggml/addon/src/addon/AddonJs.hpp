#pragma once

#include <any>
#include <memory>
#include <span>
#include <string>
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

#include "js-interface/JSAdapter.hpp"
#include "model-interface/chatterbox/ChatterboxModel.hpp"

namespace qvac::ttsggml::addon_js {

namespace js = qvac_lib_inference_addon_cpp::js;

using chatterbox::ChatterboxModel;

/**
 * Emits a `vector<int16_t>` PCM buffer to JS as
 * `{ outputArray: Int16Array, sampleRate: number }`.  Used for the final
 * (batch) synthesis result.  The sample rate is hardcoded at 24 kHz —
 * Chatterbox always emits at that rate today and there is no runtime
 * resampler in the engine.  If `outputSampleRate` becomes engine-
 * observable (rather than the current accepted-but-no-op pass-through),
 * switch this to the atomic-shared-pointer pattern used by
 * qvac-lib-infer-onnx-tts so the JS sample rate can track reload().
 */
struct JsAudioOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<int16_t>> {
  explicit JsAudioOutputHandler(int sampleRate = 24000)
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

/**
 * Streaming PCM chunk with order + end-of-stream metadata.  Pushed onto
 * the output queue by `ChatterboxModel::synthesize`'s native chunk
 * callback; emitted to JS as
 * `{ outputArray, sampleRate, chunkIndex, isLast }`.
 */
struct StreamingPcmChunk {
  std::vector<int16_t> pcm;
  int chunkIndex = 0;
  bool isLast = false;
};

struct JsStreamingPcmHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          StreamingPcmChunk> {
  explicit JsStreamingPcmHandler(int sampleRate = 24000)
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
  auto cfg = adapter.buildConfig(configurationParams, env);

  unique_ptr<model::IModel> model = make_unique<ChatterboxModel>(std::move(cfg));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<JsAudioOutputHandler>());
  outHandlers.add(make_shared<JsStreamingPcmHandler>());
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
  auto inputObj = args.getJsObject(1, "inputObj");

  if (type != "text") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  ChatterboxModel::AnyInput modelInput;
  modelInput.text = js::String(env, jsInput).as<std::string>(env);

  // Per-request config overrides used to flow through `inputObj.config`
  // into the model, but nothing honoured them — the engine is
  // persistent and all config is resolved at construction / reload.
  // Callers who want different knobs should use `model.reload(cfg)`.
  (void)inputObj;

  // Native streaming: if the ChatterboxModel is built with
  // streamChunkTokens > 0, publish each chunk's PCM to the output queue
  // as soon as it's produced so the JS onUpdate fires chunk-by-chunk —
  // same pattern as qvac-lib-infer-llamacpp-llm's per-token callback.
  // We pack the PCM with `chunkIndex` + `isLast` so the JS side can
  // preserve chunk ordering across async callback dispatch and detect
  // the final chunk without waiting for `JobEnded`.
  auto outputQueue = instance.addonCpp->outputQueue;
  modelInput.chunkCallback = [outputQueue](
      std::vector<int16_t>&& pcm, int chunkIndex, bool isLast) {
    StreamingPcmChunk chunk{std::move(pcm), chunkIndex, isLast};
    outputQueue->queueResult(std::any(std::move(chunk)));
  };

  return instance.runJob(std::any(std::move(modelInput)));
}
JSCATCH

inline js_value_t* reload(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configurationParams = args.getJsObject(1, "configurationParams");
  JSAdapter adapter;
  auto newCfg = adapter.buildConfig(configurationParams, env);

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

} // namespace qvac::ttsggml::addon_js

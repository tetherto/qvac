#pragma once

#include <any>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <js.h>
#include <tts-cpp/log.h>

#include "addon/GgmlLogForwarding.hpp"
#include "addon/VoiceControlsCatalog.hpp"
#include "js-interface/JSAdapter.hpp"
#include "model-interface/EnhancerLoader.hpp"
#include "model-interface/audio8/Audio8Model.hpp"
#include "model-interface/chatterbox/ChatterboxModel.hpp"
#include "model-interface/cosyvoice/CosyvoiceModel.hpp"
#include "model-interface/moss/MossModel.hpp"
#include "model-interface/moss/MossSoundEffectModel.hpp"
#include "model-interface/parler/ParlerModel.hpp"
#include "model-interface/pocket/PocketModel.hpp"
#include "model-interface/supertonic/SupertonicModel.hpp"

namespace qvac::ttsggml::addon_js {

namespace js = qvac_lib_inference_addon_cpp::js;

using audio8::Audio8Model;
using chatterbox::ChatterboxModel;
using cosyvoice::CosyvoiceModel;
using moss::MossModel;
using moss::MossSoundEffectModel;
using parler::ParlerModel;
using pocket::PocketModel;
using supertonic::SupertonicModel;

// One process-wide install of the native log sink. tts_cpp_log_set passes the
// callback to ggml_log_set, so ggml-origin lines (backend selection, device
// enumeration, ...) reach the JS logger instead of raw stderr. Engine
// diagnostics that tts-cpp still prints with fprintf(stderr) bypass it until
// tts-cpp routes them through its own log sink.
inline void installNativeLogForwarderOnce() {
  static std::once_flag once;
  std::call_once(once, [] { tts_cpp_log_set(&forwardGgmlLog, nullptr); });
}

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

  installNativeLogForwarderOnce();

  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  JSAdapter adapter;
  const EngineType engineType = adapter.readEngineType(configurationParams, env);

  unique_ptr<model::IModel> model;
  int sampleRate = chatterbox::kChatterboxNativeSampleRate;

  // The output sample rate is baked into the JS output handlers at instance
  // creation. Final-rate precedence:
  //   1. outputSampleRate (engine resamples, or the addon resamples after the
  //      enhancer) — always the final emitted rate when set;
  //   2. 48000 when the LavaSR enhancer is active (it always emits 48 kHz);
  //   3. the engine's native rate.
  if (engineType == EngineType::Pocket) {
    auto pm = make_unique<PocketModel>(
        adapter.buildPocketConfig(configurationParams, env));
    sampleRate = pm->sampleRate();
    model = std::move(pm);
  } else if (engineType == EngineType::Supertonic) {
    auto cfg = adapter.buildSupertonicConfig(configurationParams, env);
    const bool enhanced = !cfg.enhancerGgufPath.empty();
    const int outSr = cfg.outputSampleRate.value_or(0);
    auto stm = make_unique<SupertonicModel>(std::move(cfg));
    sampleRate =
        outSr > 0 ? outSr
                  : (enhanced ? kLavasrEnhancedSampleRate : stm->sampleRate());
    model = std::move(stm);
  } else if (engineType == EngineType::Cosyvoice) {
    auto cfg = adapter.buildCosyvoiceConfig(configurationParams, env);
    const bool enhanced = !cfg.enhancerGgufPath.empty();
    const int outSr = cfg.outputSampleRate.value_or(0);
    auto cvm = make_unique<CosyvoiceModel>(std::move(cfg));
    sampleRate = outSr > 0 ? outSr
                           : (enhanced ? kLavasrEnhancedSampleRate
                                       : cvm->sampleRate()); // native 24 kHz
    model = std::move(cvm);
  } else if (engineType == EngineType::Parler) {
    auto cfg = adapter.buildParlerConfig(configurationParams, env);
    const bool enhanced = !cfg.enhancerGgufPath.empty();
    const int outSr = cfg.outputSampleRate.value_or(0);
    auto ptm = make_unique<ParlerModel>(std::move(cfg));
    sampleRate =
        outSr > 0 ? outSr
                  : (enhanced ? kLavasrEnhancedSampleRate : ptm->sampleRate());
    model = std::move(ptm);
  } else if (engineType == EngineType::Audio8) {
    auto cfg = adapter.buildAudio8Config(configurationParams, env);
    auto atm = make_unique<Audio8Model>(std::move(cfg));
    sampleRate = audio8::emittedSampleRate(atm->config(), atm->sampleRate());
    model = std::move(atm);
  } else if (engineType == EngineType::Moss) {
    auto cfg = adapter.buildMossConfig(configurationParams, env);
    auto mtm = make_unique<MossModel>(std::move(cfg));
    sampleRate = mtm->sampleRate();
    model = std::move(mtm);
  } else if (engineType == EngineType::MossSoundEffect) {
    auto cfg = adapter.buildMossSoundEffectConfig(configurationParams, env);
    auto sfx = make_unique<MossSoundEffectModel>(std::move(cfg));
    sampleRate = sfx->sampleRate();
    model = std::move(sfx);
  } else {
    auto cfg = adapter.buildChatterboxConfig(configurationParams, env);
    const bool enhanced = !cfg.enhancerGgufPath.empty();
    const int outSr = cfg.outputSampleRate.value_or(0);
    sampleRate = outSr > 0
                     ? outSr
                     : (enhanced ? kLavasrEnhancedSampleRate
                                 : chatterbox::kChatterboxNativeSampleRate);
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

  if (dynamic_cast<PocketModel*>(&instance.addonCpp->model.get())) {
    PocketModel::AnyInput modelInput;
    modelInput.text = js::String(env, jsInput).as<std::string>(env);
    auto queue = instance.addonCpp->outputQueue;
    modelInput.chunkCallback =
        [queue](std::vector<int16_t>&& pcm, int index, bool last) {
          queue->queueResult(
              std::any(StreamingPcmChunk{std::move(pcm), index, last}));
        };
    return instance.runJob(std::any(std::move(modelInput)));
  }

  if (dynamic_cast<SupertonicModel*>(&instance.addonCpp->model.get())) {
    SupertonicModel::AnyInput modelInput;
    modelInput.text = js::String(env, jsInput).as<std::string>(env);
    // Supertonic conditions the engine at construction, so per-call emotion /
    // pace on the job object is rejected rather than silently dropped here.
    JSAdapter adapter;
    adapter.assertNoPerCallSupertonicControls(
        args.getJsObject(1, "inputObj"), env);
    // Native streaming (config streamChunkTokens > 0) uses the same queue
    // bridge as chatterbox; a batch config leaves this callback unused.
    auto outputQueue = instance.addonCpp->outputQueue;
    modelInput.chunkCallback =
        [outputQueue](std::vector<int16_t>&& pcm, int chunkIndex, bool isLast) {
          StreamingPcmChunk chunk{std::move(pcm), chunkIndex, isLast};
          outputQueue->queueResult(std::any(std::move(chunk)));
        };
    return instance.runJob(std::any(std::move(modelInput)));
  }

  if (dynamic_cast<CosyvoiceModel*>(&instance.addonCpp->model.get())) {
    // CosyVoice3 emits PCM progressively in per-chunk hops: wire the same
    // per-chunk PCM sink Chatterbox uses so streamChunkTokens delivers chunks
    // through the JS streaming output handler. NOTE: the engine currently
    // computes the full audio then slices it into chunks — chunks arrive
    // progressively but first-audio latency is not yet reduced (true
    // token2wav low-latency streaming is reserved in tts-cpp).
    CosyvoiceModel::AnyInput modelInput;
    modelInput.text = js::String(env, jsInput).as<std::string>(env);
    // Per-call conditioning rides as siblings of `input` on the job object,
    // exactly as Parler's description fields do below.
    JSAdapter adapter;
    modelInput.controls =
        adapter.readVoiceControls(args.getJsObject(1, "inputObj"), env);
    modelInput.hasControls = !modelInput.controls.empty();
    auto outputQueue = instance.addonCpp->outputQueue;
    modelInput.chunkCallback =
        [outputQueue](std::vector<int16_t>&& pcm, int chunkIndex, bool isLast) {
          StreamingPcmChunk chunk{std::move(pcm), chunkIndex, isLast};
          outputQueue->queueResult(std::any(std::move(chunk)));
        };
    return instance.runJob(std::any(std::move(modelInput)));
  }

  if (dynamic_cast<Audio8Model*>(&instance.addonCpp->model.get())) {
    Audio8Model::AnyInput modelInput;
    modelInput.text = js::String(env, jsInput).as<std::string>(env);
    // Per-call referenceAudio/referenceText are siblings of `input` on the job
    // object; all-empty means "use the constructor config".
    JSAdapter adapter;
    modelInput.voice =
        adapter.readAudio8Voice(args.getJsObject(1, "inputObj"), env);
    return instance.runJob(std::any(std::move(modelInput)));
  }

  if (dynamic_cast<MossModel*>(&instance.addonCpp->model.get())) {
    MossModel::AnyInput modelInput;
    modelInput.text = js::String(env, jsInput).as<std::string>(env);
    auto outputQueue = instance.addonCpp->outputQueue;
    modelInput.chunkCallback =
        [outputQueue](std::vector<int16_t>&& pcm, int chunkIndex, bool isLast) {
          StreamingPcmChunk chunk{std::move(pcm), chunkIndex, isLast};
          outputQueue->queueResult(std::any(std::move(chunk)));
        };
    return instance.runJob(std::any(std::move(modelInput)));
  }

  if (dynamic_cast<MossSoundEffectModel*>(&instance.addonCpp->model.get())) {
    MossSoundEffectModel::AnyInput modelInput;
    modelInput.text = js::String(env, jsInput).as<std::string>(env);
    JSAdapter adapter;
    modelInput.call =
        adapter.readMossSoundEffectCall(args.getJsObject(1, "inputObj"), env);
    return instance.runJob(std::any(std::move(modelInput)));
  }

  if (auto* pt = dynamic_cast<ParlerModel*>(&instance.addonCpp->model.get())) {
    ParlerModel::AnyInput modelInput;
    modelInput.text = js::String(env, jsInput).as<std::string>(env);
    // Per-call description/template properties are siblings of `input`
    // on the job object; all-empty means "use the constructor config".
    JSAdapter adapter;
    modelInput.desc = adapter.readParlerDescriptionFields(
        args.getJsObject(1, "inputObj"), env);
    // Native streaming (config streamChunkTokens > 0) uses the same queue
    // bridge as chatterbox; a batch config leaves this callback unused.
    auto outputQueue = instance.addonCpp->outputQueue;
    modelInput.chunkCallback =
        [outputQueue](std::vector<int16_t>&& pcm, int chunkIndex, bool isLast) {
          StreamingPcmChunk chunk{std::move(pcm), chunkIndex, isLast};
          outputQueue->queueResult(std::any(std::move(chunk)));
        };
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

inline js::Array
toJsStringArray(js_env_t* env, const std::vector<std::string>& values) {
  auto array = js::Array::create(env);
  for (size_t i = 0; i < values.size(); ++i) {
    array.set(
        env, static_cast<uint32_t>(i), js::String::create(env, values[i]));
  }
  return array;
}

// Instance-free capability query: tts-cpp's canonical emotion / pace
// vocabulary and each engine's supported subset, keyed by tts-cpp's engine
// name, so a host can list what is settable before loading a model.
inline js_value_t*
getVoiceControls(js_env_t* env, js_callback_info_t* /*info*/) try {
  const VoiceControlsCatalog catalog = voiceControlsCatalog();
  auto result = js::Object::create(env);
  result.setProperty(env, "emotions", toJsStringArray(env, catalog.emotions));
  result.setProperty(env, "paces", toJsStringArray(env, catalog.paces));
  auto engines = js::Object::create(env);
  for (const EngineVoiceControls& engine : catalog.engines) {
    auto entry = js::Object::create(env);
    entry.setProperty(env, "emotions", toJsStringArray(env, engine.emotions));
    entry.setProperty(env, "paces", toJsStringArray(env, engine.paces));
    engines.setProperty(env, engine.engine.c_str(), entry);
  }
  result.setProperty(env, "engines", engines);
  return result;
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

  if (dynamic_cast<PocketModel*>(&instance.addonCpp->model.get())) {
    auto config = adapter.buildPocketConfig(configurationParams, env);
    return js::JsAsyncTask::run(
        env, [addon = instance.addonCpp, config = std::move(config)]() mutable {
          dynamic_cast<PocketModel&>(addon->model.get())
              .reload(std::move(config));
        });
  }

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

  if (dynamic_cast<CosyvoiceModel*>(&instance.addonCpp->model.get())) {
    auto newCfg = adapter.buildCosyvoiceConfig(configurationParams, env);
    return js::JsAsyncTask::run(
        env,
        [addonCpp = instance.addonCpp, newCfg = std::move(newCfg)]() mutable {
          auto* cvm = dynamic_cast<CosyvoiceModel*>(&addonCpp->model.get());
          if (cvm == nullptr) {
            throw qvac_errors::StatusError(
                qvac_errors::general_error::InternalError,
                "reload: model is not a CosyvoiceModel");
          }
          cvm->setConfig(std::move(newCfg));
          cvm->reload();
        });
  }

  if (dynamic_cast<Audio8Model*>(&instance.addonCpp->model.get())) {
    auto newCfg = adapter.buildAudio8Config(configurationParams, env);
    return js::JsAsyncTask::run(
        env,
        [addonCpp = instance.addonCpp, newCfg = std::move(newCfg)]() mutable {
          auto* atm = dynamic_cast<Audio8Model*>(&addonCpp->model.get());
          if (atm == nullptr) {
            throw qvac_errors::StatusError(
                qvac_errors::general_error::InternalError,
                "reload: model is not an Audio8Model");
          }
          atm->reloadWith(std::move(newCfg));
        });
  }

  if (dynamic_cast<MossModel*>(&instance.addonCpp->model.get())) {
    auto newCfg = adapter.buildMossConfig(configurationParams, env);
    return js::JsAsyncTask::run(
        env,
        [addonCpp = instance.addonCpp, newCfg = std::move(newCfg)]() mutable {
          auto* mtm = dynamic_cast<MossModel*>(&addonCpp->model.get());
          if (mtm == nullptr) {
            throw qvac_errors::StatusError(
                qvac_errors::general_error::InternalError,
                "reload: model is not a MossModel");
          }
          mtm->reloadWith(std::move(newCfg));
        });
  }

  if (dynamic_cast<MossSoundEffectModel*>(&instance.addonCpp->model.get())) {
    auto newCfg = adapter.buildMossSoundEffectConfig(configurationParams, env);
    return js::JsAsyncTask::run(
        env,
        [addonCpp = instance.addonCpp, newCfg = std::move(newCfg)]() mutable {
          auto* sfx =
              dynamic_cast<MossSoundEffectModel*>(&addonCpp->model.get());
          if (sfx == nullptr) {
            throw qvac_errors::StatusError(
                qvac_errors::general_error::InternalError,
                "reload: model is not a MossSoundEffectModel");
          }
          sfx->reloadWith(std::move(newCfg));
        });
  }

  if (auto* pt = dynamic_cast<ParlerModel*>(&instance.addonCpp->model.get())) {
    auto newCfg = adapter.buildParlerConfig(configurationParams, env);
    return js::JsAsyncTask::run(
        env,
        [addonCpp = instance.addonCpp, newCfg = std::move(newCfg)]() mutable {
          auto* ptm = dynamic_cast<ParlerModel*>(&addonCpp->model.get());
          if (ptm == nullptr) {
            throw qvac_errors::StatusError(
                qvac_errors::general_error::InternalError,
                "reload: model is not a ParlerModel");
          }
          ptm->setConfig(std::move(newCfg));
          ptm->reload();
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

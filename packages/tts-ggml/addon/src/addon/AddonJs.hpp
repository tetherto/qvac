#pragma once

#include <any>
#include <memory>
#include <mutex>
#include <optional>
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
#include "model-interface/parler/ParlerModel.hpp"
#include "model-interface/supertonic/SupertonicModel.hpp"

#include <tts-cpp/audio8/fit.h>
#include <tts-cpp/chatterbox/fit.h>
#include <tts-cpp/cosyvoice/fit.h>
#include <tts-cpp/parler/fit.h>
#include <tts-cpp/supertonic/fit.h>

namespace qvac::ttsggml::addon_js {

namespace js = qvac_lib_inference_addon_cpp::js;

using audio8::Audio8Model;
using chatterbox::ChatterboxModel;
using cosyvoice::CosyvoiceModel;
using moss::MossModel;
using parler::ParlerModel;
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
  if (engineType == EngineType::Supertonic) {
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

// ── assessFit ────────────────────────────────────────────────────────────
//
// Projects one voice against the memory free right now. Args: [request], whose
// `engineType` picks the fitter and whose remaining keys carry that engine's
// files and workload.
//
// Takes no instance and loads nothing: every fitter reads GGUF metadata only.
// A model one cannot read is an "error" status carrying its own reason, never
// a throw.

inline js_value_t*
fitResultToJs(js_env_t* env, const tts_cpp::FitResult& fit) {
  const char* status = "error";
  if (fit.status == tts_cpp::FitStatus::Success) {
    status = "fits";
  } else if (fit.status == tts_cpp::FitStatus::Failure) {
    status = "does-not-fit";
  }

  auto result = js::Object::create(env);
  auto text = [&](const char* name, const std::string& value) {
    result.setProperty(env, name, js::String::create(env, value));
  };
  auto bytes = [&](const char* name, uint64_t value) {
    result.setProperty(
        env, name, js::Number::create(env, static_cast<double>(value)));
  };

  text("status", status);
  text("reason", fit.reason);
  text("modelVariant", fit.model_variant);
  text("deviceName", fit.device_name);
  text("report", fit.report);
  result.setProperty(
      env, "deviceIsCpu", js::Boolean::create(env, fit.device_is_cpu));
  result.setProperty(
      env,
      "deviceSharesHostMemory",
      js::Boolean::create(env, fit.device_shares_host_memory));
  bytes("deviceFreeBytes", fit.device_free_bytes);
  bytes("deviceTotalBytes", fit.device_total_bytes);
  bytes("deviceBytes", fit.device.total_bytes);
  bytes("weightsBytes", fit.device.weights_bytes);
  bytes("stateBytes", fit.device.state_bytes);
  bytes("lmComputeBytes", fit.device.lm_compute_bytes);
  bytes("codecComputeBytes", fit.device.codec_compute_bytes);
  bytes("hostBytes", fit.host_bytes);
  return result;
}

inline js_value_t* assessFit(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  auto request = args.getJsObject(0, "request");
  // A load infers the engine from the file keys it carries when `engineType`
  // is absent. A fit request carries none of those keys, so the inference
  // would name an engine the caller never asked for.
  auto engineType = request.getOptionalProperty<js::String>(env, "engineType");
  if (!engineType.has_value() || engineType->as<std::string>(env).empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "assessFit: engineType is required");
  }
  JSAdapter adapter;
  const EngineType engine = adapter.readEngineType(request, env);

  auto text = [&](const char* name) -> std::string {
    auto value = request.getOptionalProperty<js::String>(env, name);
    return value.has_value() ? value->as<std::string>(env) : std::string();
  };
  auto number = [&](const char* name) -> std::optional<double> {
    auto value = request.getOptionalProperty<js::Number>(env, name);
    if (!value.has_value()) {
      return std::nullopt;
    }
    return value->as<double>(env);
  };
  auto integer = [&](const char* name, int& out) {
    if (auto value = number(name)) {
      out = static_cast<int>(*value);
    }
  };

  const std::string backendsDir = text("backendsDir");
  const int gpuLayers = static_cast<int>(number("gpuLayers").value_or(0));
  auto margin = [&](uint64_t& out) {
    if (auto bytes = number("marginBytes")) {
      out = static_cast<uint64_t>(*bytes);
    }
  };
  auto vulkanDevice = [&](int& out) {
    if (auto index = number("vulkanDevice")) {
      out = static_cast<int>(*index);
    }
  };

  switch (engine) {
  case EngineType::Supertonic: {
    tts_cpp::supertonic::FitOptions options;
    options.model_gguf_path = text("modelPath");
    options.backends_dir = backendsDir;
    options.n_gpu_layers = gpuLayers;
    integer("textTokens", options.text_tokens);
    integer("steps", options.steps);
    margin(options.margin_bytes);
    vulkanDevice(options.vulkan_device);
    if (auto precision = request.getOptionalProperty<js::String>(env, "precision")) {
      options.precision = precision->as<std::string>(env);
    }
    integer("f16Weights", options.f16_weights);
    if (auto seconds = number("audioSeconds")) {
      options.audio_seconds = static_cast<float>(*seconds);
    }
    return fitResultToJs(env, tts_cpp::supertonic::fit_params(options));
  }
  case EngineType::Parler: {
    tts_cpp::parler::FitOptions options;
    options.model_gguf_path = text("modelPath");
    options.backends_dir = backendsDir;
    options.n_gpu_layers = gpuLayers;
    integer("descriptionTokens", options.description_tokens);
    integer("promptTokens", options.prompt_tokens);
    integer("maxFrames", options.max_frames);
    margin(options.margin_bytes);
    return fitResultToJs(env, tts_cpp::parler::fit_params(options));
  }
  case EngineType::Chatterbox: {
    tts_cpp::chatterbox::FitOptions options;
    options.t3_gguf_path = text("t3Path");
    options.s3gen_gguf_path = text("s3genPath");
    options.kv_cache_type = text("kvCacheType");
    options.backends_dir = backendsDir;
    options.n_gpu_layers = gpuLayers;
    integer("contextSize", options.n_ctx);
    integer("textTokens", options.text_tokens);
    integer("predictTokens", options.n_predict);
    margin(options.margin_bytes);
    return fitResultToJs(env, tts_cpp::chatterbox::fit_params(options));
  }
  case EngineType::Audio8: {
    tts_cpp::audio8::FitOptions options;
    options.lm_gguf_path = text("lmPath");
    options.codec_decoder_gguf_path = text("codecDecoderPath");
    options.codec_encoder_gguf_path = text("codecEncoderPath");
    options.backends_dir = backendsDir;
    options.n_gpu_layers = gpuLayers;
    integer("promptTokens", options.prompt_tokens);
    integer("maxFrames", options.max_frames);
    if (auto seconds = number("referenceSeconds")) {
      options.reference_seconds = static_cast<float>(*seconds);
    }
    margin(options.margin_bytes);
    return fitResultToJs(env, tts_cpp::audio8::fit_params(options));
  }
  case EngineType::Cosyvoice: {
    tts_cpp::cosyvoice::FitOptions options;
    options.llm_gguf_path = text("llmPath");
    options.flow_gguf_path = text("flowPath");
    options.hift_gguf_path = text("hiftPath");
    options.voice_gguf_path = text("voicePath");
    options.backends_dir = backendsDir;
    options.n_gpu_layers = gpuLayers;
    integer("textTokens", options.text_tokens);
    integer("speechTokens", options.speech_tokens);
    margin(options.margin_bytes);
    vulkanDevice(options.vulkan_device);
    return fitResultToJs(env, tts_cpp::cosyvoice::fit_params(options));
  }
  // speech-cpp exposes no fitter for MOSS, so it falls to the throw below.
  case EngineType::Moss:
    break;
  }

  throw StatusError(
      general_error::InvalidArgument, "assessFit: unsupported engineType");
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

#pragma once

// Unified JS verb implementations for the two ASR engines (whisper +
// parakeet). One verb table (binding.cpp) registers every verb
// unconditionally; per-engine behavior is decided inside each verb by
// `dynamic_cast` on `instance.addonCpp->model.get()` -- the tts-ggml
// three-engine dispatch pattern. Engine selection at createInstance() time
// goes through JSAdapter::readEngineType().

#include <any>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include <ggml.h>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <js.h>
#include <parakeet/log.h>
#include <whisper.h>

#include "addon/AsrErrors.hpp"
#include "addon/GgmlLogForwarding.hpp"
#include "addon/StreamingSessionRegistry.hpp"
#include "js-interface/JSAdapter.hpp"
#include "model-interface/ParakeetStreamingProcessor.hpp"
#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/StreamingProcessor.hpp"
#include "model-interface/WhisperTypes.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"
#include "model-interface/whisper/WhisperModel.hpp"

namespace qvac::asrggml::addon_js {

namespace js = qvac_lib_inference_addon_cpp::js;
using qvac_lib_inference_addon_cpp::OutputQueue;

// ── Native log forwarding ────────────────────────────────────────────────
//
// One process-wide install, shared by both engines. Hook choice:
//   - ggml_log_set(forwardGgmlLog) covers ggml-origin lines in
//     parakeet-only processes.
//   - parakeet_log_set(forwardGgmlLog) routes speech-cpp's own parakeet
//     lines ("[parakeet] ..." warnings, prewarm diagnostics), which otherwise
//     go to stderr. It also re-applies the callback to ggml.
//   - whisper_log_set(forwardGgmlLog) stores the callback in whisper's
//     g_state.log_callback AND re-applies it to ggml -- both immediately and
//     again inside whisper_backend_init_gpu() (src/whisper.cpp). A raw
//     ggml_log_set alone would therefore be clobbered by whisper's init,
//     while this order guarantees whisper-origin lines (whisper_model_load,
//     "whisper_backend_init_gpu: using <name> backend", ...) and ggml-origin
//     lines ("ggml_vulkan: Found N Vulkan devices ...") all land in the same
//     forwardGgmlLog -> QLOG -> JsLogger pipe, whichever engine initializes
//     later. There is no second callback left to clobber.
inline void installNativeLogForwarderOnce() {
  static std::once_flag once;
  std::call_once(once, [] {
    ggml_log_set(&forwardGgmlLog, nullptr);
    parakeet_log_set(&forwardGgmlLog, nullptr);
    whisper_log_set(&forwardGgmlLog, nullptr);
  });
}

// ── Whisper output handlers ──────────────────────────────────────────────
//
// text / toAppend / start / end / id keep their pre-merge shape. language
// and noSpeechProb are always set; speakerTurnNext (tdrz_enable) and tokens
// (token_timestamps) only when the matching whisperConfig flag is on.

inline js::Object
whisperTranscriptToJsObject(js_env_t* env, const whisper::Transcript& t) {
  auto obj = js::Object::create(env);
  obj.setProperty(env, "text", js::String::create(env, t.text));
  obj.setProperty(env, "toAppend", js::Boolean::create(env, t.toAppend));
  obj.setProperty(env, "start", js::Number::create(env, t.start));
  obj.setProperty(env, "end", js::Number::create(env, t.end));
  obj.setProperty(
      env, "id", js::Number::create(env, static_cast<uint64_t>(t.id)));
  if (!t.language.empty()) {
    obj.setProperty(env, "language", js::String::create(env, t.language));
  }
  obj.setProperty(env, "noSpeechProb", js::Number::create(env, t.noSpeechProb));
  if (t.speakerTurnNext.has_value()) {
    obj.setProperty(
        env, "speakerTurnNext", js::Boolean::create(env, *t.speakerTurnNext));
  }
  if (t.tokens.has_value()) {
    auto tokens = js::Array::create(env);
    for (size_t i = 0; i < t.tokens->size(); ++i) {
      const auto& token = (*t.tokens)[i];
      auto jsToken = js::Object::create(env);
      jsToken.setProperty(env, "text", js::String::create(env, token.text));
      jsToken.setProperty(env, "start", js::Number::create(env, token.start));
      jsToken.setProperty(env, "end", js::Number::create(env, token.end));
      jsToken.setProperty(
          env, "probability", js::Number::create(env, token.probability));
      tokens.set(env, i, jsToken);
    }
    obj.setProperty(env, "tokens", tokens);
  }
  return obj;
}

struct JsWhisperTranscriptHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          whisper::Transcript> {
  JsWhisperTranscriptHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            whisper::Transcript>(
            [this](const whisper::Transcript& output) -> js_value_t* {
              return whisperTranscriptToJsObject(this->env_, output);
            }) {}
};

struct JsWhisperTranscriptArrayHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<whisper::Transcript>> {
  JsWhisperTranscriptArrayHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<whisper::Transcript>>(
            [this](
                const std::vector<whisper::Transcript>& output) -> js_value_t* {
              auto jsOutput = js::Array::create(this->env_);
              for (size_t i = 0; i < output.size(); ++i) {
                jsOutput.set(
                    this->env_,
                    i,
                    whisperTranscriptToJsObject(this->env_, output[i]));
              }
              return jsOutput;
            }) {}
};

struct JsVadStateHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          whisper::VadStateUpdate> {
  JsVadStateHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            whisper::VadStateUpdate>(
            [this](const whisper::VadStateUpdate& output) -> js_value_t* {
              auto jsOutput = js::Object::create(this->env_);
              jsOutput.setProperty(
                  this->env_, "type", js::String::create(this->env_, "vad"));
              jsOutput.setProperty(
                  this->env_,
                  "speaking",
                  js::Boolean::create(this->env_, output.speaking));
              jsOutput.setProperty(
                  this->env_,
                  "probability",
                  js::Number::create(this->env_, output.probability));
              return jsOutput;
            }) {}
};

struct JsEndOfTurnHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          whisper::EndOfTurnEvent> {
  JsEndOfTurnHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            whisper::EndOfTurnEvent>(
            [this](const whisper::EndOfTurnEvent& output) -> js_value_t* {
              auto jsOutput = js::Object::create(this->env_);
              jsOutput.setProperty(
                  this->env_,
                  "type",
                  js::String::create(this->env_, "endOfTurn"));
              jsOutput.setProperty(
                  this->env_,
                  "silenceDurationMs",
                  js::Number::create(this->env_, output.silenceDurationMs));
              return jsOutput;
            }) {}
};

// ── Parakeet output handler + helpers ────────────────────────────────────

inline js::Object
transcriptToJsObject(js_env_t* env, const parakeet::Transcript& t) {
  auto obj = js::Object::create(env);
  obj.setProperty(env, "text", js::String::create(env, t.text));
  obj.setProperty(env, "toAppend", js::Boolean::create(env, t.toAppend));
  obj.setProperty(env, "start", js::Number::create(env, t.start));
  obj.setProperty(env, "end", js::Number::create(env, t.end));
  obj.setProperty(
      env, "id", js::Number::create(env, static_cast<uint64_t>(t.id)));
  obj.setProperty(env, "isEndOfTurn", js::Boolean::create(env, t.isEndOfTurn));
  obj.setProperty(env, "startsWord", js::Boolean::create(env, t.startsWord));
  // Sortformer only; ASR segments keep their existing shape.
  if (t.speakerId >= 0) {
    obj.setProperty(env, "speakerId", js::Number::create(env, t.speakerId));
  }
  if (!t.speakerSegments.empty()) {
    auto segments = js::Array::create(env);
    for (size_t i = 0; i < t.speakerSegments.size(); ++i) {
      const auto& seg = t.speakerSegments[i];
      auto jsSeg = js::Object::create(env);
      jsSeg.setProperty(
          env, "speakerId", js::Number::create(env, seg.speakerId));
      jsSeg.setProperty(env, "start", js::Number::create(env, seg.start));
      jsSeg.setProperty(env, "end", js::Number::create(env, seg.end));
      segments.set(env, i, jsSeg);
    }
    obj.setProperty(env, "speakerSegments", segments);
  }
  return obj;
}

inline js_value_t* transcriptsToJsArray(
    js_env_t* env, const std::vector<parakeet::Transcript>& output) {
  auto jsOutput = js::Array::create(env);
  for (size_t i = 0; i < output.size(); ++i) {
    jsOutput.set(env, i, transcriptToJsObject(env, output[i]));
  }
  return jsOutput;
}

struct JsParakeetTranscriptArrayHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<parakeet::Transcript>> {
  JsParakeetTranscriptArrayHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<parakeet::Transcript>>(
            [this](const std::vector<parakeet::Transcript>& output)
                -> js_value_t* {
              return transcriptsToJsArray(this->env_, output);
            }) {}
};

// Parakeet streaming VAD transition: `{ type: "vad", speaking, score,
// timestamp, source, speakerId? }`. source is "energy" or "sortformer";
// speakerId is present only when a Sortformer speaker enters speech.
struct JsParakeetVadEventHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          parakeet::VadEvent> {
  JsParakeetVadEventHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            parakeet::VadEvent>(
            [this](const parakeet::VadEvent& event) -> js_value_t* {
              auto obj = js::Object::create(this->env_);
              obj.setProperty(
                  this->env_, "type", js::String::create(this->env_, "vad"));
              obj.setProperty(
                  this->env_,
                  "speaking",
                  js::Boolean::create(this->env_, event.speaking));
              obj.setProperty(
                  this->env_,
                  "score",
                  js::Number::create(this->env_, event.score));
              obj.setProperty(
                  this->env_,
                  "timestamp",
                  js::Number::create(this->env_, event.timestamp));
              obj.setProperty(
                  this->env_,
                  "source",
                  js::String::create(
                      this->env_,
                      event.source == parakeet::VadSource::Sortformer
                          ? "sortformer"
                          : "energy"));
              if (event.speakerId >= 0) {
                obj.setProperty(
                    this->env_,
                    "speakerId",
                    js::Number::create(this->env_, event.speakerId));
              }
              return obj;
            }) {}
};

// ── createInstance ───────────────────────────────────────────────────────

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  installNativeLogForwarderOnce();

  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  JSAdapter adapter;
  const EngineType engineType =
      adapter.readEngineType(configurationParams, env);

  unique_ptr<model::IModel> model;
  parakeet::ParakeetModel* parakeetModel = nullptr;
  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outputHandlers;
  if (engineType == EngineType::Parakeet) {
    auto ownedModel = make_unique<parakeet::ParakeetModel>(
        adapter.buildParakeetConfig(configurationParams, env));
    parakeetModel = ownedModel.get();
    model = std::move(ownedModel);
    outputHandlers.add(make_shared<JsParakeetTranscriptArrayHandler>());
    outputHandlers.add(make_shared<JsParakeetVadEventHandler>());
  } else {
    model = make_unique<whisper::WhisperModel>(
        adapter.buildWhisperConfig(configurationParams, env));
    outputHandlers.add(make_shared<JsWhisperTranscriptHandler>());
    outputHandlers.add(make_shared<JsWhisperTranscriptArrayHandler>());
    outputHandlers.add(make_shared<JsVadStateHandler>());
    outputHandlers.add(make_shared<JsEndOfTurnHandler>());
  }

  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outputHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));
  if (parakeetModel != nullptr) {
    // Framework-path streaming (cfg.streaming) VAD transitions share the
    // job output queue; the duplex path queues its own.
    parakeetModel->setOnVadEventCallback([queue = addon->addonCpp->outputQueue](
                                             const parakeet::VadEvent& event) {
      queue->queueResult(std::any(event));
    });
  }
  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

// ── runJob ───────────────────────────────────────────────────────────────
//
// Per-engine input encoding is kept (QIP audio-boundary rule lives in JS):
// parakeet takes a Float32Array; whisper takes raw bytes + audio_format
// (default "s16le"). Whisper is the fall-through arm (the default engine),
// matching tts-ggml where chatterbox is fall-through.

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto [type, jsInput] = JsInterface::getInput(args);

  if (type != "audio") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  if (dynamic_cast<parakeet::ParakeetModel*>(&instance.addonCpp->model.get()) !=
      nullptr) {
    vector<float> inputSamples =
        js::TypedArray<float>(env, jsInput).as<vector<float>>(env);
    return instance.runJob(any(std::move(inputSamples)));
  }

  auto inputObj = args.getJsObject(1, "inputObj");
  string audioFormat = "s16le";
  auto maybeAudioFormat =
      inputObj.getOptionalProperty<js::String>(env, "audio_format");
  if (maybeAudioFormat.has_value()) {
    audioFormat = maybeAudioFormat.value().as<std::string>(env);
  }

  vector<uint8_t> audioBytes =
      js::TypedArray<uint8_t>(env, jsInput).as<std::vector<uint8_t>>(env);
  auto samples =
      whisper::WhisperModel::preprocessAudioData(audioBytes, audioFormat);

  whisper::WhisperModel::AnyInput anyInput;
  anyInput.input = std::move(samples);
  anyInput.outputCallback = [&instance](const whisper::Transcript& transcript) {
    instance.addonCpp->outputQueue->queueResult(std::any(transcript));
  };

  return instance.runJob(std::any(std::move(anyInput)));
}
JSCATCH

// ── reload (whisper-only; the parakeet arm is a guard rail) ─────────────

inline js_value_t* reload(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  if (dynamic_cast<parakeet::ParakeetModel*>(&instance.addonCpp->model.get()) !=
      nullptr) {
    throw errors::parakeet::makeStatus(
        errors::parakeet::Code::ReloadNotSupported,
        "reload is not supported for the parakeet engine; destroy and "
        "recreate the instance");
  }

  auto configurationParams = args.getJsObject(1, "configurationParams");
  JSAdapter adapter;
  whisper::WhisperConfig config =
      adapter.buildWhisperConfig(configurationParams, env);

  return js::JsAsyncTask::run(
      env,
      [addonCpp = instance.addonCpp, config = std::move(config)]() mutable {
        auto* whisperModel =
            dynamic_cast<whisper::WhisperModel*>(&addonCpp->model.get());
        if (whisperModel == nullptr) {
          throw std::runtime_error("Invalid model type for reload");
        }
        whisperModel->setConfig(config);
      });
}
JSCATCH

// ── getBackendInfo ───────────────────────────────────────────────────────
//
// Returns the backend the engine resolved at load() as a JS object:
// `{ backendDevice, backendId, backendName, backendDescription,
// encoderBackend, encoderOnCoreml }` (+ whisper-only extras
// `gpuMemTotalMb`/`gpuMemFreeMb`, -1 = device does not report). The
// description is the human-readable GPU name (e.g. "NVIDIA GeForce RTX
// 3090") recovered from the ggml device registry; it is the
// nvidia-smi-independent fallback the perf reporter uses on CI runners
// where the host probes can't see the GPU. encoderBackend is "coreml" when
// parakeet's FastConformer encoder runs on the Apple Neural Engine sidecar,
// else it mirrors backendName; the whisper-cpp port builds without
// WHISPER_COREML, so its arm always reports encoderOnCoreml=false -- the
// keys exist purely for cross-engine shape stability. Available after
// activate(); reports CPU/"" before load.

inline js_value_t* getBackendInfo(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto result = js::Object::create(env);

  if (auto* parakeetModel = dynamic_cast<parakeet::ParakeetModel*>(
          &instance.addonCpp->model.get())) {
    const int deviceClass = parakeetModel->getBackendDeviceClass();
    result.setProperty(
        env,
        "backendDevice",
        js::String::create(env, std::string(deviceClass == 1 ? "GPU" : "CPU")));
    result.setProperty(
        env,
        "backendId",
        js::Number::create(env, parakeetModel->getBackendId()));
    result.setProperty(
        env,
        "backendName",
        js::String::create(env, parakeetModel->getBackendName()));
    result.setProperty(
        env,
        "backendDescription",
        js::String::create(env, parakeetModel->getBackendDescription()));
    result.setProperty(
        env,
        "encoderBackend",
        js::String::create(env, parakeetModel->getEncoderBackend()));
    result.setProperty(
        env,
        "encoderOnCoreml",
        js::Boolean::create(env, parakeetModel->getEncoderOnCoreml() != 0));
    result.setProperty(
        env,
        "modelType",
        js::String::create(env, parakeetModel->getModelTypeName()));
    return result;
  }

  auto& whisperModel =
      dynamic_cast<whisper::WhisperModel&>(instance.addonCpp->model.get());
  const auto deviceClass = whisperModel.getBackendDeviceClass();
  result.setProperty(
      env,
      "backendDevice",
      js::String::create(env, std::string(deviceClass == 1 ? "GPU" : "CPU")));
  result.setProperty(
      env,
      "backendId",
      js::Number::create(
          env, static_cast<double>(whisperModel.getBackendId())));
  result.setProperty(
      env,
      "backendName",
      js::String::create(env, whisperModel.getBackendName()));
  result.setProperty(
      env,
      "backendDescription",
      js::String::create(env, whisperModel.getBackendDescription()));
  // Mirror of backendName: whisper has no encoder sidecar.
  result.setProperty(
      env,
      "encoderBackend",
      js::String::create(env, whisperModel.getBackendName()));
  result.setProperty(env, "encoderOnCoreml", js::Boolean::create(env, false));
  result.setProperty(env, "modelType", js::String::create(env, "whisper"));
  // Whisper-only extras: device-memory snapshot at load().
  result.setProperty(
      env,
      "gpuMemTotalMb",
      js::Number::create(
          env, static_cast<double>(whisperModel.getGpuMemTotalMb())));
  result.setProperty(
      env,
      "gpuMemFreeMb",
      js::Number::create(
          env, static_cast<double>(whisperModel.getGpuMemFreeMb())));
  return result;
}
JSCATCH

// ── startStreaming ───────────────────────────────────────────────────────
//
// The two config vocabularies stay disjoint by design (QIP amendment 2):
// whisper requires `vadModelPath` + `jobId` and takes VAD tuning knobs;
// parakeet takes model-default overrides. Both arms construct their session
// through the one registry's validate-then-construct seam
// (emplaceStreamingSession), so a double-start throws before any processor
// exists, and both return `true`.

namespace detail {

inline whisper::StreamingProcessor::Config
parseWhisperStreamingConfig(js_env_t* env, js::Object& configObj) {
  whisper::StreamingProcessor::Config config;

  auto maybeVadModelPath =
      configObj.getOptionalProperty<js::String>(env, "vadModelPath");
  if (maybeVadModelPath.has_value()) {
    config.vadModelPath = maybeVadModelPath.value().as<std::string>(env);
  }
  if (config.vadModelPath.empty()) {
    throw std::runtime_error("vadModelPath is required for streaming");
  }

  auto maybeJobId = configObj.getOptionalProperty<js::Number>(env, "jobId");
  if (!maybeJobId.has_value()) {
    throw std::runtime_error("jobId is required for streaming");
  }
  const double jobIdDouble = maybeJobId.value().as<double>(env);
  if (!(jobIdDouble >= 1.0)) {
    throw std::runtime_error("jobId must be a positive integer");
  }
  config.jobId = static_cast<decltype(config.jobId)>(jobIdDouble);

  auto maybeVadThreshold =
      configObj.getOptionalProperty<js::Number>(env, "vadThreshold");
  if (maybeVadThreshold.has_value()) {
    config.vadThreshold =
        static_cast<float>(maybeVadThreshold.value().as<double>(env));
  }

  auto maybeMinSilence =
      configObj.getOptionalProperty<js::Number>(env, "minSilenceDurationMs");
  if (maybeMinSilence.has_value()) {
    config.minSilenceDurationMs =
        static_cast<int>(maybeMinSilence.value().as<double>(env));
  }

  auto maybeMinSpeech =
      configObj.getOptionalProperty<js::Number>(env, "minSpeechDurationMs");
  if (maybeMinSpeech.has_value()) {
    config.minSpeechDurationMs =
        static_cast<int>(maybeMinSpeech.value().as<double>(env));
  }

  auto maybeMaxSpeech =
      configObj.getOptionalProperty<js::Number>(env, "maxSpeechDurationS");
  if (maybeMaxSpeech.has_value()) {
    config.maxSpeechDurationS =
        static_cast<float>(maybeMaxSpeech.value().as<double>(env));
    config.maxBufferSamples =
        static_cast<int>(config.maxSpeechDurationS) * config.sampleRate;
  }

  auto maybeSpeechPad =
      configObj.getOptionalProperty<js::Number>(env, "speechPadMs");
  if (maybeSpeechPad.has_value()) {
    config.speechPadMs =
        static_cast<int>(maybeSpeechPad.value().as<double>(env));
  }

  auto maybeSamplesOverlap =
      configObj.getOptionalProperty<js::Number>(env, "samplesOverlap");
  if (maybeSamplesOverlap.has_value()) {
    config.samplesOverlap =
        static_cast<float>(maybeSamplesOverlap.value().as<double>(env));
  }

  auto maybeEmitVadEvents =
      configObj.getOptionalProperty<js::Boolean>(env, "emitVadEvents");
  if (maybeEmitVadEvents.has_value()) {
    config.emitVadEvents = maybeEmitVadEvents.value().as<bool>(env);
  }

  auto maybeEndOfTurnSilence =
      configObj.getOptionalProperty<js::Number>(env, "endOfTurnSilenceMs");
  if (maybeEndOfTurnSilence.has_value()) {
    config.endOfTurnSilenceMs =
        static_cast<int>(maybeEndOfTurnSilence.value().as<double>(env));
  }

  auto maybeVadRunInterval =
      configObj.getOptionalProperty<js::Number>(env, "vadRunIntervalMs");
  if (maybeVadRunInterval.has_value()) {
    const double vadRunIntervalMs = maybeVadRunInterval.value().as<double>(env);
    if (vadRunIntervalMs > 0.0) {
      config.vadRunIntervalSamples = static_cast<int>(
          vadRunIntervalMs * static_cast<double>(config.sampleRate) / 1000.0);
      if (config.vadRunIntervalSamples <= 0) {
        config.vadRunIntervalSamples = 1;
      }
    }
  }

  return config;
}

inline parakeet::ParakeetStreamingProcessor::Config
streamingConfigFromModel(parakeet::ParakeetModel& model) {
  parakeet::ParakeetStreamingProcessor::Config config;
  config.sampleRate = model.getSampleRate();
  config.chunkMs = model.getStreamingChunkMs();
  config.historyMs = model.getStreamingHistoryMs();
  config.emitPartials = model.getStreamingEmitPartials();
  config.emitEnergyVad = model.getStreamingEnergyVad();
  config.energyVadThresholdDb = model.getStreamingEnergyVadThresholdDb();
  config.energyVadWindowMs = model.getStreamingEnergyVadWindowMs();
  config.energyVadHangoverMs = model.getStreamingEnergyVadHangoverMs();
  config.emitSpeakerVad = model.getStreamingSpeakerVad();
  config.diarOnsetThreshold = model.getDiarizationThreshold();
  config.diarMinSegmentMs = model.getDiarizationMinSegmentMs();
  config.leftContextMs = model.getStreamingLeftContextMs();
  config.rightLookaheadMs = model.getStreamingRightLookaheadMs();
  config.spkCacheEnable = model.getStreamingSpkCacheEnable();
  config.spkCacheLen = model.getStreamingSpkCacheLen();
  config.fifoLen = model.getStreamingFifoLen();
  config.chunkLeftContextMs = model.getStreamingChunkLeftContextMs();
  config.chunkRightContextMs = model.getStreamingChunkRightContextMs();
  config.spkCacheUpdatePeriod = model.getStreamingSpkCacheUpdatePeriod();
  return config;
}

inline void overrideIfPositive(
    js_env_t* env, js::Object& obj, const char* name, int& target) {
  if (auto value = obj.getOptionalPropertyAs<js::Number, double>(env, name)) {
    const int intValue = static_cast<int>(*value);
    if (intValue > 0)
      target = intValue;
  }
}

inline void overrideIfNonNegative(
    js_env_t* env, js::Object& obj, const char* name, int& target) {
  if (auto value = obj.getOptionalPropertyAs<js::Number, double>(env, name)) {
    const int intValue = static_cast<int>(*value);
    if (intValue >= 0)
      target = intValue;
  }
}

inline void
overrideBool(js_env_t* env, js::Object& obj, const char* name, bool& target) {
  if (auto value = obj.getOptionalPropertyAs<js::Boolean, bool>(env, name)) {
    target = *value;
  }
}

inline void overrideIfFinite(
    js_env_t* env, js::Object& obj, const char* name, float& target) {
  if (auto value = obj.getOptionalPropertyAs<js::Number, double>(env, name)) {
    if (std::isfinite(*value))
      target = static_cast<float>(*value);
  }
}

inline void overrideIfUnitInterval(
    js_env_t* env, js::Object& obj, const char* name, float& target) {
  if (auto value = obj.getOptionalPropertyAs<js::Number, double>(env, name)) {
    if (*value >= 0.0 && *value <= 1.0)
      target = static_cast<float>(*value);
  }
}

inline void applyStreamingOverrides(
    js_env_t* env, js::Object& configObj,
    parakeet::ParakeetStreamingProcessor::Config& config) {
  overrideIfPositive(env, configObj, "chunkMs", config.chunkMs);
  overrideIfPositive(env, configObj, "historyMs", config.historyMs);
  overrideIfPositive(env, configObj, "leftContextMs", config.leftContextMs);
  overrideIfNonNegative(
      env, configObj, "rightLookaheadMs", config.rightLookaheadMs);
  overrideBool(env, configObj, "emitPartials", config.emitPartials);
  overrideBool(env, configObj, "emitEnergyVad", config.emitEnergyVad);
  overrideIfFinite(
      env, configObj, "energyVadThresholdDb", config.energyVadThresholdDb);
  overrideIfPositive(
      env, configObj, "energyVadWindowMs", config.energyVadWindowMs);
  overrideIfNonNegative(
      env, configObj, "energyVadHangoverMs", config.energyVadHangoverMs);
  overrideBool(env, configObj, "emitSpeakerVad", config.emitSpeakerVad);
  overrideIfUnitInterval(
      env, configObj, "diarizationThreshold", config.diarOnsetThreshold);
  overrideIfNonNegative(
      env, configObj, "diarizationMinSegmentMs", config.diarMinSegmentMs);
  // AOSC per-call overrides (v2.1+ Sortformer only).
  overrideBool(env, configObj, "spkCacheEnable", config.spkCacheEnable);
  overrideIfPositive(env, configObj, "spkCacheLen", config.spkCacheLen);
  overrideIfPositive(env, configObj, "fifoLen", config.fifoLen);
  overrideIfNonNegative(
      env, configObj, "chunkLeftContextMs", config.chunkLeftContextMs);
  overrideIfNonNegative(
      env, configObj, "chunkRightContextMs", config.chunkRightContextMs);
  overrideIfPositive(
      env, configObj, "spkCacheUpdatePeriod", config.spkCacheUpdatePeriod);
}

} // namespace detail

inline js_value_t* startStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configObj = args.getJsObject(1, "config");

  // Order matters, and it is the pre-merge order: parse/validate the config,
  // then let the registry run the double-start check and the construction as
  // one atomic step. The engine session is therefore never built on the
  // duplicate path -- building it first would start a second worker thread
  // against the shared model (whisper: processLoop's first statement resets
  // the live session's stats and clears its output_ vector; parakeet: a
  // second stream_start() on a single-session Engine) before the throw.
  // `factory` runs under the registry lock, so it must not touch the registry.
  if (auto* parakeetModel = dynamic_cast<parakeet::ParakeetModel*>(
          &instance.addonCpp->model.get())) {
    parakeet::ParakeetStreamingProcessor::Config config =
        detail::streamingConfigFromModel(*parakeetModel);
    detail::applyStreamingOverrides(env, configObj, config);
    emplaceStreamingSession(
        &instance, [&]() -> std::unique_ptr<IStreamingSession> {
          return std::make_unique<parakeet::ParakeetStreamingProcessor>(
              *parakeetModel, instance.addonCpp->outputQueue, config);
        });
  } else {
    whisper::StreamingProcessor::Config config =
        detail::parseWhisperStreamingConfig(env, configObj);
    auto& whisperModel =
        dynamic_cast<whisper::WhisperModel&>(instance.addonCpp->model.get());
    emplaceStreamingSession(
        &instance, [&]() -> std::unique_ptr<IStreamingSession> {
          return std::make_unique<whisper::StreamingProcessor>(
              whisperModel, instance.addonCpp->outputQueue, config);
        });
  }

  // Informational only; the JS drivers synthesise their own jobIds.
  return js::Boolean::create(env, true);
}
JSCATCH

// ── appendStreamingAudio ─────────────────────────────────────────────────
//
// Returns false iff the decoded sample count was 0; throws when no session
// is active. Input encoding matches runJob's per-engine rule.

inline js_value_t*
appendStreamingAudio(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto [type, jsInput] = JsInterface::getInput(args);

  if (type != "audio") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  vector<float> samples;
  if (dynamic_cast<parakeet::ParakeetModel*>(&instance.addonCpp->model.get()) !=
      nullptr) {
    samples = js::TypedArray<float>(env, jsInput).as<vector<float>>(env);
  } else {
    auto inputObj = args.getJsObject(1, "inputObj");
    std::string audioFormat = "s16le";
    auto maybeAudioFormat =
        inputObj.getOptionalProperty<js::String>(env, "audio_format");
    if (maybeAudioFormat.has_value()) {
      audioFormat = maybeAudioFormat.value().as<std::string>(env);
    }
    auto audioBytes =
        js::TypedArray<uint8_t>(env, jsInput).as<std::vector<uint8_t>>(env);
    samples =
        whisper::WhisperModel::preprocessAudioData(audioBytes, audioFormat);
  }

  if (samples.empty()) {
    return js::Boolean::create(env, false);
  }

  IStreamingSession* session = findStreamingSession(&instance);
  if (session == nullptr) {
    throw std::runtime_error("No active streaming session for this instance");
  }

  session->appendAudio(std::move(samples));
  return js::Boolean::create(env, true);
}
JSCATCH

// ── endStreaming ─────────────────────────────────────────────────────────
//
// Unified teardown-object return for both engines:
// `{ cleaned, audioDurationMs, totalSamples }`. `cleaned` is false when no
// session existed. end() is the graceful path: trailing audio flushes and
// the worker joins before the counters are read, so the JS drivers can
// populate a synthetic JobEnded's stats with real values.

inline js_value_t* endStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  bool cleaned = false;
  double audioDurationMs = 0.0;
  int64_t totalSamples = 0;

  if (std::unique_ptr<IStreamingSession> session =
          takeStreamingSession(&instance)) {
    session->end();
    // end() joined the worker thread, so the counters are read race-free.
    const double audioSeconds = session->audioSeconds();
    cleaned = true;
    audioDurationMs = audioSeconds * 1000.0;
    totalSamples = static_cast<int64_t>(std::llround(
        audioSeconds * static_cast<double>(session->sampleRate())));
  }

  auto out = js::Object::create(env);
  out.setProperty(env, "cleaned", js::Boolean::create(env, cleaned));
  out.setProperty(
      env, "audioDurationMs", js::Number::create(env, audioDurationMs));
  out.setProperty(
      env,
      "totalSamples",
      js::Number::create(env, static_cast<double>(totalSamples)));
  return out;
}
JSCATCH

// ── cancel ───────────────────────────────────────────────────────────────
//
// One implementation for both engines, on whisper's async shape: the
// session cancel (worker-thread join) and the framework job cancel both run
// inside JsAsyncTask, off the JS event loop.
//
// The session leaves the registry synchronously but is cancelled/joined only
// when the async task runs, so between the two a startStreaming() would find
// an empty registry while the old worker is still touching the shared model.
// Callers must therefore await the returned promise before starting a new
// stream -- both JS drivers do (`await this.addon.cancel(...)` in
// WhisperDriver/ParakeetDriver.cancelActive). This is whisper's pre-merge
// shape; parakeet's pre-merge cancel joined the worker synchronously on the
// JS thread, so the await is what preserves its ordering guarantee.

inline js_value_t*
cancelWithStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  std::shared_ptr<IStreamingSession> session =
      takeStreamingSessionShared(&instance);

  return js::JsAsyncTask::run(env, [addonCpp = instance.addonCpp, session]() {
    if (session) {
      session->cancel();
    }
    addonCpp->cancelJob();
  });
}
JSCATCH

// ── destroyInstance ──────────────────────────────────────────────────────

inline js_value_t*
destroyInstanceWithStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  // Forceful streaming cleanup first, then the framework teardown.
  if (std::unique_ptr<IStreamingSession> session =
          takeStreamingSession(&instance)) {
    session->cancel();
  }

  return JsInterface::destroyInstance(env, info);
}
JSCATCH

} // namespace qvac::asrggml::addon_js

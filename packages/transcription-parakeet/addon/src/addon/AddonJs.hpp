#pragma once

#include <any>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include <js.h>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "model-interface/ParakeetStreamingProcessor.hpp"
#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"
#include "js-interface/JSAdapter.hpp"

namespace qvac_lib_infer_parakeet {

namespace js = qvac_lib_inference_addon_cpp::js;

// One processor per AddonJs instance. Lives between startStreaming()
// and endStreaming() / cancel() / destroyInstance(). Looked up by raw
// AddonJs* pointer because the addon framework owns AddonJs lifetime
// via JsInterface.
inline std::mutex g_streamingMtx;
inline std::unordered_map<
    qvac_lib_inference_addon_cpp::AddonJs*,
    std::unique_ptr<ParakeetStreamingProcessor>>
    g_streamingSessions;

inline ParakeetConfig createParakeetConfig(
    js_env_t* env, const js::Object& configurationParams) {
  JSAdapter adapter;
  return adapter.loadFromJSObject(configurationParams, env);
}

struct JsParakeetOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<Transcript>> {
  JsParakeetOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<Transcript>>(
            [this](const std::vector<Transcript>& output) -> js_value_t* {
              auto jsOutput = js::Array::create(this->env_);
              for (size_t i = 0; i < output.size(); ++i) {
                auto jsTranscript = js::Object::create(this->env_);
                jsTranscript.setProperty(
                    this->env_,
                    "text",
                    js::String::create(this->env_, output[i].text));
                jsTranscript.setProperty(
                    this->env_,
                    "toAppend",
                    js::Boolean::create(this->env_, output[i].toAppend));
                jsTranscript.setProperty(
                    this->env_,
                    "start",
                    js::Number::create(this->env_, output[i].start));
                jsTranscript.setProperty(
                    this->env_,
                    "end",
                    js::Number::create(this->env_, output[i].end));
                jsTranscript.setProperty(
                    this->env_,
                    "id",
                    js::Number::create(
                        this->env_, static_cast<uint64_t>(output[i].id)));
                jsTranscript.setProperty(
                    this->env_,
                    "isEndOfTurn",
                    js::Boolean::create(this->env_, output[i].isEndOfTurn));
                jsTranscript.setProperty(
                    this->env_,
                    "startsWord",
                    js::Boolean::create(this->env_, output[i].startsWord));
                jsOutput.set(this->env_, i, jsTranscript);
              }
              return jsOutput;
            }) {}
};

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  unique_ptr<model::IModel> model =
      make_unique<ParakeetModel>(createParakeetConfig(env, configurationParams));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outputHandlers;
  outputHandlers.add(make_shared<JsParakeetOutputHandler>());

  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outputHandlers));

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

  if (type != "audio") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  vector<float> inputSamples =
      js::TypedArray<float>(env, jsInput).as<vector<float>>(env);
  return instance.runJob(any(std::move(inputSamples)));
}
JSCATCH

// ─── Duplex streaming entry points ────────────────────────────────────────
// Mirrors qvac-lib-infer-whispercpp's StreamingProcessor wiring. Each
// addon instance can host at most one active streaming session at a
// time. Audio appended via appendStreamingAudio() bypasses the
// framework's append() -> runJob() -> process() lifecycle entirely;
// per-segment Transcripts are queued straight into addonCpp->outputQueue,
// so the existing JS `onUpdate` channel surfaces them as soon as the
// engine emits each chunk. Tear down via endStreaming() (graceful) or
// cancelWithStreaming() (forceful).

inline js_value_t*
startStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configObj = args.getJsObject(1, "config");

  auto& parakeetModel =
      dynamic_cast<ParakeetModel&>(instance.addonCpp->model.get());

  ParakeetStreamingProcessor::Config config;
  config.sampleRate         = parakeetModel.getSampleRate();
  config.chunkMs            = parakeetModel.getStreamingChunkMs();
  config.historyMs          = parakeetModel.getStreamingHistoryMs();
  config.emitPartials       = parakeetModel.getStreamingEmitPartials();
  config.emitEnergyVad      = parakeetModel.getStreamingEnergyVad();
  config.diarOnsetThreshold = parakeetModel.getDiarOnsetThreshold();
  config.diarMinSegmentMs   = static_cast<int>(
      parakeetModel.getDiarMinDurationOn() * 1000.0F);
  config.leftContextMs      = parakeetModel.getStreamingLeftContextMs();
  config.rightLookaheadMs   = parakeetModel.getStreamingRightLookaheadMs();

  if (auto chunkMs =
          configObj.getOptionalProperty<js::Number>(env, "chunkMs");
      chunkMs.has_value()) {
    const auto v = static_cast<int>(chunkMs.value().as<double>(env));
    if (v > 0) config.chunkMs = v;
  }
  if (auto historyMs =
          configObj.getOptionalProperty<js::Number>(env, "historyMs");
      historyMs.has_value()) {
    const auto v = static_cast<int>(historyMs.value().as<double>(env));
    if (v > 0) config.historyMs = v;
  }
  if (auto leftContextMs =
          configObj.getOptionalProperty<js::Number>(env, "leftContextMs");
      leftContextMs.has_value()) {
    const auto v = static_cast<int>(leftContextMs.value().as<double>(env));
    if (v > 0) config.leftContextMs = v;
  }
  if (auto rightLookaheadMs =
          configObj.getOptionalProperty<js::Number>(env, "rightLookaheadMs");
      rightLookaheadMs.has_value()) {
    const auto v = static_cast<int>(rightLookaheadMs.value().as<double>(env));
    if (v >= 0) config.rightLookaheadMs = v;
  }
  if (auto emitPartials =
          configObj.getOptionalProperty<js::Boolean>(env, "emitPartials");
      emitPartials.has_value()) {
    config.emitPartials = emitPartials.value().as<bool>(env);
  }
  if (auto emitEnergyVad =
          configObj.getOptionalProperty<js::Boolean>(env, "emitEnergyVad");
      emitEnergyVad.has_value()) {
    config.emitEnergyVad = emitEnergyVad.value().as<bool>(env);
  }

  {
    std::lock_guard<std::mutex> lock(g_streamingMtx);
    if (g_streamingSessions.count(&instance) != 0) {
      throw std::runtime_error(
          "Streaming session already active for this instance");
    }
    g_streamingSessions[&instance] =
        std::make_unique<ParakeetStreamingProcessor>(
            parakeetModel, instance.addonCpp->outputQueue, config);
  }

  // The return value is informational only -- ParakeetInterface's
  // startStreaming() in parakeet.js synthesises its own currentJobId and
  // discards this value. Kept as Boolean(true) instead of switching to
  // a void / undefined return so existing JS callers (and the
  // MockedBinding parity tests) keep working unchanged.
  return js::Boolean::create(env, true);
}
JSCATCH

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

  vector<float> samples =
      js::TypedArray<float>(env, jsInput).as<vector<float>>(env);
  if (samples.empty()) {
    return js::Boolean::create(env, false);
  }

  ParakeetStreamingProcessor* processor = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_streamingMtx);
    auto it = g_streamingSessions.find(&instance);
    if (it == g_streamingSessions.end()) {
      throw std::runtime_error("No active streaming session for this instance");
    }
    processor = it->second.get();
  }

  processor->appendAudio(std::move(samples));
  return js::Boolean::create(env, true);
}
JSCATCH

// Snapshot of stats captured from a ParakeetStreamingProcessor right
// before tear-down so endStreaming() can return them to the JS layer
// for the synthetic JobEnded payload.
struct StreamingTeardownStats {
  bool   cleaned          = false;
  double audioDurationMs  = 0.0;
  int64_t totalSamples    = 0;
};

// Tear down the streaming session for `instance`. When `forceful` is
// true the underlying parakeet session is canceled (in-flight feed
// aborts); otherwise it is finalized so trailing audio flushes. Returns
// the audio-duration / sample-count seen by the processor up to (and
// including) the final flush so JS can populate response.stats; the
// `cleaned` flag is false when no session existed.
inline StreamingTeardownStats
cleanupStreamingSession(
    qvac_lib_inference_addon_cpp::AddonJs& instance, bool forceful = false) {
  std::unique_ptr<ParakeetStreamingProcessor> processor;
  {
    std::lock_guard<std::mutex> lock(g_streamingMtx);
    auto it = g_streamingSessions.find(&instance);
    if (it == g_streamingSessions.end()) return {};
    processor = std::move(it->second);
    g_streamingSessions.erase(it);
  }
  if (forceful) {
    processor->cancel();
  } else {
    processor->end();
  }
  // end()/cancel() join the worker thread, so audio_seconds_ is now
  // observed without a data race.
  StreamingTeardownStats stats;
  stats.cleaned         = true;
  stats.audioDurationMs = processor->audioSeconds() * 1000.0;
  stats.totalSamples    = static_cast<int64_t>(
      processor->audioSeconds() *
      static_cast<double>(processor->sampleRate()));
  return stats;
}

inline js_value_t*
endStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  const StreamingTeardownStats stats =
      cleanupStreamingSession(instance, /*forceful=*/false);

  // Return an object so JS can populate the synthetic JobEnded with
  // the actual audio duration / sample count rather than zeros. The
  // shape mirrors what the JS layer feeds into _addonOutputCallback's
  // sniff path: cleaned (was-there-a-session) + audioDurationMs +
  // totalSamples.
  auto out = js::Object::create(env);
  out.setProperty(env, "cleaned", js::Boolean::create(env, stats.cleaned));
  out.setProperty(env, "audioDurationMs",
                  js::Number::create(env, stats.audioDurationMs));
  out.setProperty(env, "totalSamples",
                  js::Number::create(env,
                                     static_cast<double>(stats.totalSamples)));
  return out;
}
JSCATCH

inline js_value_t*
cancelWithStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  cleanupStreamingSession(instance, /*forceful=*/true);

  // Fall through to the framework's regular cancel so any in-flight
  // batch job (the offline path) is also aborted.
  return JsInterface::cancel(env, info);
}
JSCATCH

inline js_value_t*
destroyInstanceWithStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  cleanupStreamingSession(instance, /*forceful=*/true);

  return JsInterface::destroyInstance(env, info);
}
JSCATCH

} // namespace qvac_lib_infer_parakeet

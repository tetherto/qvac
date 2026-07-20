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

inline js::Object transcriptToJsObject(js_env_t* env, const Transcript& t) {
  auto obj = js::Object::create(env);
  obj.setProperty(env, "text", js::String::create(env, t.text));
  obj.setProperty(env, "toAppend", js::Boolean::create(env, t.toAppend));
  obj.setProperty(env, "start", js::Number::create(env, t.start));
  obj.setProperty(env, "end", js::Number::create(env, t.end));
  obj.setProperty(
      env, "id", js::Number::create(env, static_cast<uint64_t>(t.id)));
  obj.setProperty(env, "isEndOfTurn", js::Boolean::create(env, t.isEndOfTurn));
  obj.setProperty(env, "startsWord", js::Boolean::create(env, t.startsWord));
  return obj;
}

inline js_value_t*
transcriptsToJsArray(js_env_t* env, const std::vector<Transcript>& output) {
  auto jsOutput = js::Array::create(env);
  for (size_t i = 0; i < output.size(); ++i) {
    jsOutput.set(env, i, transcriptToJsObject(env, output[i]));
  }
  return jsOutput;
}

struct JsParakeetOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<Transcript>> {
  JsParakeetOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<Transcript>>(
            [this](const std::vector<Transcript>& output) -> js_value_t* {
              return transcriptsToJsArray(this->env_, output);
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

// Returns the backend the engine resolved at load() as a JS object:
// `{ backendDevice, backendId, backendName, backendDescription }`. The
// description is the human-readable GPU name (e.g. "NVIDIA GeForce RTX 3090")
// recovered from the ggml device registry; it is the nvidia-smi-independent
// fallback the perf reporter uses on CI runners where the host probes can't
// see the GPU. Available after activate(); reports CPU/"" before load.
inline js_value_t* getBackendInfo(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto& parakeetModel =
      dynamic_cast<ParakeetModel&>(instance.addonCpp->model.get());

  const int deviceClass = parakeetModel.getBackendDeviceClass();
  auto result = js::Object::create(env);
  result.setProperty(
      env,
      "backendDevice",
      js::String::create(env, std::string(deviceClass == 1 ? "GPU" : "CPU")));
  result.setProperty(
      env, "backendId", js::Number::create(env, parakeetModel.getBackendId()));
  result.setProperty(
      env,
      "backendName",
      js::String::create(env, parakeetModel.getBackendName()));
  result.setProperty(
      env,
      "backendDescription",
      js::String::create(env, parakeetModel.getBackendDescription()));
  return result;
}
JSCATCH

// Duplex streaming entry points. One session per addon instance; audio from
// appendStreamingAudio() bypasses the append()/runJob()/process() lifecycle
// and queues per-segment Transcripts straight into addonCpp->outputQueue.

inline ParakeetStreamingProcessor::Config
streamingConfigFromModel(ParakeetModel& model) {
  ParakeetStreamingProcessor::Config config;
  config.sampleRate = model.getSampleRate();
  config.chunkMs = model.getStreamingChunkMs();
  config.historyMs = model.getStreamingHistoryMs();
  config.emitPartials = model.getStreamingEmitPartials();
  config.emitEnergyVad = model.getStreamingEnergyVad();
  config.diarOnsetThreshold = model.getDiarOnsetThreshold();
  config.diarMinSegmentMs =
      static_cast<int>(model.getDiarMinDurationOn() * 1000.0F);
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

inline void applyStreamingOverrides(
    js_env_t* env, js::Object& configObj,
    ParakeetStreamingProcessor::Config& config) {
  overrideIfPositive(env, configObj, "chunkMs", config.chunkMs);
  overrideIfPositive(env, configObj, "historyMs", config.historyMs);
  overrideIfPositive(env, configObj, "leftContextMs", config.leftContextMs);
  overrideIfNonNegative(
      env, configObj, "rightLookaheadMs", config.rightLookaheadMs);
  overrideBool(env, configObj, "emitPartials", config.emitPartials);
  overrideBool(env, configObj, "emitEnergyVad", config.emitEnergyVad);
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

inline js_value_t*
startStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configObj = args.getJsObject(1, "config");

  auto& parakeetModel =
      dynamic_cast<ParakeetModel&>(instance.addonCpp->model.get());

  ParakeetStreamingProcessor::Config config =
      streamingConfigFromModel(parakeetModel);
  applyStreamingOverrides(env, configObj, config);

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

  // Informational only; parakeet.js synthesises its own jobId.
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

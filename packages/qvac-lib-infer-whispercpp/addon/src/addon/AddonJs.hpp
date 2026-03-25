#pragma once

#include <any>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

#include <js.h>
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <whisper.h>

#include "model-interface/StreamingProcessor.hpp"
#include "model-interface/WhisperTypes.hpp"
#include "model-interface/whisper.cpp/WhisperModel.hpp"
#include "src/js-interface/JSAdapter.hpp"

namespace qvac_lib_inference_addon_whisper {

inline std::mutex g_streamingMtx;
inline std::unordered_map<
    qvac_lib_inference_addon_cpp::AddonJs*,
    std::unique_ptr<StreamingProcessor>> g_streamingSessions;

namespace js = qvac_lib_inference_addon_cpp::js;
using qvac_lib_inference_addon_cpp::OutputQueue;

inline void disableWhisperLogs(
    enum ggml_log_level /*level*/, const char* /*text*/, void* /*userData*/) {}

inline WhisperConfig
createWhisperConfig(js_env_t* env, const js::Object& configurationParams) {
  JSAdapter adapter;
  return adapter.loadFromJSObject(configurationParams, env);
}

struct JsTranscriptOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<Transcript> {
  JsTranscriptOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            Transcript>([this](const Transcript& output) -> js_value_t* {
          auto jsTranscript = js::Object::create(this->env_);
          jsTranscript.setProperty(
              this->env_, "text", js::String::create(this->env_, output.text));
          jsTranscript.setProperty(
              this->env_,
              "toAppend",
              js::Boolean::create(this->env_, output.toAppend));
          jsTranscript.setProperty(
              this->env_,
              "start",
              js::Number::create(this->env_, output.start));
          jsTranscript.setProperty(
              this->env_, "end", js::Number::create(this->env_, output.end));
          jsTranscript.setProperty(
              this->env_,
              "id",
              js::Number::create(this->env_, static_cast<uint64_t>(output.id)));
          return jsTranscript;
        }) {}
};

struct JsTranscriptArrayOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<Transcript>> {
  JsTranscriptArrayOutputHandler()
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
                jsOutput.set(this->env_, i, jsTranscript);
              }
              return jsOutput;
            }) {}
};

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  whisper_log_set(disableWhisperLogs, nullptr);
  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  unique_ptr<model::IModel> model =
      make_unique<WhisperModel>(createWhisperConfig(env, configurationParams));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outputHandlers;
  outputHandlers.add(make_shared<JsTranscriptOutputHandler>());
  outputHandlers.add(make_shared<JsTranscriptArrayOutputHandler>());
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
  auto inputObj = args.getJsObject(1, "inputObj");

  if (type != "audio") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  string audioFormat = "s16le";
  auto maybeAudioFormat =
      inputObj.getOptionalProperty<js::String>(env, "audio_format");
  if (maybeAudioFormat.has_value()) {
    audioFormat = maybeAudioFormat.value().as<std::string>(env);
  }

  vector<uint8_t> audioBytes =
      js::TypedArray<uint8_t>(env, jsInput).as<std::vector<uint8_t>>(env);
  auto samples = WhisperModel::preprocessAudioData(audioBytes, audioFormat);
  return instance.runJob(std::any(std::move(samples)));
}
JSCATCH

inline js_value_t* reload(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configurationParams = args.getJsObject(1, "configurationParams");
  WhisperConfig config = createWhisperConfig(env, configurationParams);

  return js::JsAsyncTask::run(
      env,
      [addonCpp = instance.addonCpp, config = std::move(config)]() mutable {
        auto* whisperModel =
            dynamic_cast<WhisperModel*>(&addonCpp->model.get());
        if (whisperModel == nullptr) {
          throw std::runtime_error("Invalid model type for reload");
        }
        whisperModel->setConfig(config);
      });
}
JSCATCH

inline js_value_t*
startStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configObj = args.getJsObject(1, "config");

  StreamingProcessor::Config config;

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
  config.jobId = static_cast<JobId>(jobIdDouble);

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

  {
    std::lock_guard lock(g_streamingMtx);

    if (g_streamingSessions.count(&instance) != 0) {
      throw std::runtime_error(
          "Streaming session already active for this instance");
    }

    auto& whisperModel =
        dynamic_cast<WhisperModel&>(instance.addonCpp->model.get());
    g_streamingSessions[&instance] = std::make_unique<StreamingProcessor>(
        whisperModel,
        instance.addonCpp->outputQueue,
        config);
  }

  return js::Boolean::create(env, true);
}
JSCATCH

inline js_value_t*
appendStreamingAudio(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto [type, jsInput] = JsInterface::getInput(args);
  auto inputObj = args.getJsObject(1, "inputObj");

  if (type != "audio") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  std::string audioFormat = "s16le";
  auto maybeAudioFormat =
      inputObj.getOptionalProperty<js::String>(env, "audio_format");
  if (maybeAudioFormat.has_value()) {
    audioFormat = maybeAudioFormat.value().as<std::string>(env);
  }

  auto audioBytes =
      js::TypedArray<uint8_t>(env, jsInput).as<std::vector<uint8_t>>(env);
  auto samples = WhisperModel::preprocessAudioData(audioBytes, audioFormat);

  if (samples.empty()) {
    return js::Boolean::create(env, false);
  }

  StreamingProcessor* processor = nullptr;
  {
    std::lock_guard lock(g_streamingMtx);
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

// Tear down and remove any active streaming session for `instance`.
// When `forceful` is true the model is asked to abort in-flight work first.
// Returns true if a session was cleaned up, false if none existed.
inline bool
cleanupStreamingSession(
    qvac_lib_inference_addon_cpp::AddonJs& instance, bool forceful = false) {
  std::unique_ptr<StreamingProcessor> processor;
  {
    std::lock_guard lock(g_streamingMtx);
    auto it = g_streamingSessions.find(&instance);
    if (it == g_streamingSessions.end()) {
      return false;
    }
    processor = std::move(it->second);
    g_streamingSessions.erase(it);
  }
  if (forceful) {
    processor->cancel();
  } else {
    processor->end();
  }
  return true;
}

inline js_value_t*
cancelWithStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  std::shared_ptr<StreamingProcessor> processor;
  {
    std::lock_guard lock(g_streamingMtx);
    auto it = g_streamingSessions.find(&instance);
    if (it != g_streamingSessions.end()) {
      processor = std::shared_ptr<StreamingProcessor>(
          std::move(it->second));
      g_streamingSessions.erase(it);
    }
  }

  return js::JsAsyncTask::run(
      env,
      [addonCppRef = instance.addonCpp, processor]() {
        if (processor) {
          processor->cancel();
        }
        addonCppRef->cancelJob();
      });
}
JSCATCH

inline js_value_t*
destroyInstanceWithStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  cleanupStreamingSession(instance, true);

  return JsInterface::destroyInstance(env, info);
}
JSCATCH

inline js_value_t*
endStreaming(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  bool cleaned = cleanupStreamingSession(instance, false);
  return js::Boolean::create(env, cleaned);
}
JSCATCH

} // namespace qvac_lib_inference_addon_whisper

#pragma once

#include <algorithm>
#include <any>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
#include <os/proc.h>
#endif
#endif

#include <audiogen-cpp/acestep/fit.h>
#ifdef AUDIOGEN_HAS_MINIMAX
#include <audiogen-cpp/minimax/fit.h>
#endif
#include <ggml-backend.h>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <js.h>

#include "addon/AppMemoryBudget.hpp"
#include "js-interface/JSAdapter.hpp"
#include "model-interface/AudioGenProgress.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/acestep/AcestepModel.hpp"
#ifdef AUDIOGEN_HAS_MINIMAX
#include "model-interface/minimax/MinimaxModel.hpp"
#endif

namespace qvac::audiogenggml::addon_js {

namespace js = qvac_lib_inference_addon_cpp::js;

using acestep::AcestepModel;
#ifdef AUDIOGEN_HAS_MINIMAX
using minimax::MinimaxModel;
#endif

inline constexpr double K_MAXIMUM_SAFE_INTEGER = 9007199254740991.0;
inline constexpr int K_MAXIMUM_INFERENCE_STEPS = 1000;

inline std::optional<double>
readOptionalNumber(js::Object object, js_env_t* env, const char* name) {
  js_value_t* raw = object.getProperty(env, name);
  if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
    return std::nullopt;
  }
  if (!js::is<js::Number>(env, raw)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(name) + " must be a number");
  }
  return js::Number::fromValue(raw).as<double>(env);
}

inline int64_t checkedSafeInteger(double value, const char* name) {
  if (!std::isfinite(value) || std::trunc(value) != value ||
      std::fabs(value) > K_MAXIMUM_SAFE_INTEGER) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(name) + " must be a safe integer");
  }
  return static_cast<int64_t>(value);
}

inline int64_t checkedPositiveSafeInteger(double value, const char* name) {
  const int64_t integer = checkedSafeInteger(value, name);
  if (integer <= 0) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(name) + " must be at least 1");
  }
  return integer;
}

inline int checkedInt32(double value, const char* name) {
  const int64_t integer = checkedSafeInteger(value, name);
  if (integer < std::numeric_limits<int>::min() ||
      integer > std::numeric_limits<int>::max()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(name) + " must be an int32 integer");
  }
  return static_cast<int>(integer);
}

inline float checkedFloat32(double value, const char* name) {
  const double maximum = std::numeric_limits<float>::max();
  if (!std::isfinite(value) || std::fabs(value) > maximum) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(name) + " must be a finite float32 number");
  }
  return static_cast<float>(value);
}

inline int checkedInferenceSteps(double value) {
  const int64_t integer = checkedSafeInteger(value, "inferenceSteps");
  if (integer < 0 || integer > K_MAXIMUM_INFERENCE_STEPS) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "inferenceSteps must be between 0 and 1000");
  }
  return static_cast<int>(integer);
}

// ACE-Step DiT timestep shift; 0 = auto (turbo 3.0, base/sft 1.0). A positive
// value that rounds to a float32 zero would silently select auto instead.
inline float checkedAcestepShift(double value) {
  const double maximum = std::numeric_limits<float>::max();
  const double minimum = std::numeric_limits<float>::denorm_min();
  if (!std::isfinite(value) || value < 0.0 || value > maximum ||
      (value > 0.0 && value < minimum)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "shift must be 0 or a positive float32 value");
  }
  return static_cast<float>(value);
}

inline float checkedMinimaxCfgScale(double value) {
  const double maximum = std::numeric_limits<float>::max();
  const double minimum = std::numeric_limits<float>::denorm_min();
  if (!std::isfinite(value) || value < 0.0 || value > maximum ||
      (value > 0.0 && value < minimum)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "cfgScale must be 0 or a positive float32 value");
  }
  return static_cast<float>(value);
}

inline std::vector<int>
copyAudioCodes(js_env_t* env, js::TypedArray<int32_t> array) {
  int32_t* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          array,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error("audioCodes must be an Int32Array");
  }
  return {data, data + len};
}

inline std::vector<float>
copyFloat32Pcm(js_env_t* env, js::TypedArray<float> array, const char* name) {
  float* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          array,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error(std::string(name) + " must be a Float32Array");
  }
  return {data, data + len};
}

inline std::optional<std::string>
readOptionalString(js::Object object, js_env_t* env, const char* name) {
  return object.getOptionalPropertyAs<js::String, std::string>(env, name);
}

inline std::optional<double>
readOptionalAcestepNumber(js::Object object, js_env_t* env, const char* name) {
  js_value_t* raw = object.getProperty(env, name);
  if (!js::is<js::Number>(env, raw))
    return std::nullopt;
  return js::Number::fromValue(raw).as<double>(env);
}

inline std::optional<bool>
readOptionalBoolean(js::Object object, js_env_t* env, const char* name) {
  js_value_t* raw = object.getProperty(env, name);
  if (!js::is<js::Boolean>(env, raw))
    return std::nullopt;
  return js::Boolean{env, raw}.as<bool>(env);
}

#ifdef AUDIOGEN_HAS_MINIMAX
inline MinimaxModel::AnyInput
buildMinimaxInput(js_env_t* env, js::Object jobObject, js_value_t* input) {
  MinimaxModel::AnyInput modelInput;
  modelInput.caption = js::String(env, input).as<std::string>(env);
  if (auto value = readOptionalString(jobObject, env, "lyrics")) {
    modelInput.lyrics = *value;
  }
  if (auto value = readOptionalNumber(jobObject, env, "seed")) {
    modelInput.seed = checkedSafeInteger(*value, "seed");
  }
  if (auto value = readOptionalNumber(jobObject, env, "maxFrames")) {
    modelInput.maxFrames = checkedPositiveSafeInteger(*value, "maxFrames");
  }
  if (auto value = readOptionalNumber(jobObject, env, "inferenceSteps")) {
    modelInput.inferenceSteps = checkedInferenceSteps(*value);
  }
  if (auto value = readOptionalNumber(jobObject, env, "cfgScale")) {
    modelInput.cfgScale = checkedMinimaxCfgScale(*value);
  }
  return modelInput;
}
#endif

inline AcestepModel::AnyInput
buildAcestepInput(js_env_t* env, js::Object jobObject, js_value_t* input) {
  AcestepModel::AnyInput modelInput;
  modelInput.caption = js::String(env, input).as<std::string>(env);
  if (auto value = readOptionalString(jobObject, env, "lyrics"))
    modelInput.lyrics = *value;
  if (auto value = readOptionalString(jobObject, env, "vocalLanguage"))
    modelInput.vocalLanguage = *value;
  if (auto value = readOptionalString(jobObject, env, "keyscale"))
    modelInput.keyscale = *value;
  if (auto value = readOptionalString(jobObject, env, "timesignature"))
    modelInput.timesignature = *value;
  // The keys shared by generation and edit runs are range-checked before the
  // cast; the remaining generation-only keys keep the lenient
  // readOptionalAcestepNumber + cast (a non-number is ignored).
  if (auto value = readOptionalAcestepNumber(jobObject, env, "seed"))
    modelInput.seed = checkedSafeInteger(*value, "seed");
  if (auto value = readOptionalAcestepNumber(jobObject, env, "bpm"))
    modelInput.bpm = checkedInt32(*value, "bpm");
  if (auto value =
          readOptionalBoolean(jobObject, env, "augmentCaptionWithMetadata"))
    modelInput.augmentCaptionWithMetadata = *value;
  if (auto value = readOptionalAcestepNumber(jobObject, env, "duration"))
    modelInput.duration = static_cast<float>(*value);
  if (auto value = readOptionalAcestepNumber(jobObject, env, "lmTemperature"))
    modelInput.lmTemperature = static_cast<float>(*value);
  if (auto value = readOptionalAcestepNumber(jobObject, env, "lmTopP"))
    modelInput.lmTopP = static_cast<float>(*value);
  if (auto value = readOptionalAcestepNumber(jobObject, env, "lmTopK"))
    modelInput.lmTopK = static_cast<int>(*value);
  if (auto value = readOptionalAcestepNumber(jobObject, env, "lmCfgScale"))
    modelInput.lmCfgScale = static_cast<float>(*value);
  if (auto value = readOptionalBoolean(jobObject, env, "lmPhase1"))
    modelInput.lmPhase1 = *value;
  if (auto value = readOptionalBoolean(jobObject, env, "simpleMode"))
    modelInput.simpleMode = *value;
  if (auto value = readOptionalBoolean(jobObject, env, "rewriteQuery"))
    modelInput.rewriteQuery = *value;
  if (auto value = readOptionalBoolean(jobObject, env, "normalizeLoudness"))
    modelInput.normalizeLoudness = *value;
  if (auto value = readOptionalBoolean(jobObject, env, "generateLrc"))
    modelInput.generateLrc = *value;
  if (auto value = readOptionalBoolean(jobObject, env, "computeQualityScore"))
    modelInput.computeQualityScore = *value;
  if (auto value = readOptionalBoolean(jobObject, env, "dcwEnabled"))
    modelInput.dcwEnabled = *value;
  if (auto value = readOptionalAcestepNumber(jobObject, env, "dcwScaler"))
    modelInput.dcwScaler = checkedFloat32(*value, "dcwScaler");
  if (auto value = readOptionalAcestepNumber(jobObject, env, "dcwHighScaler"))
    modelInput.dcwHighScaler = checkedFloat32(*value, "dcwHighScaler");
  if (auto codes = jobObject.getOptionalProperty<js::TypedArray<int32_t>>(
          env, "audioCodes")) {
    modelInput.audioCodes = copyAudioCodes(env, *codes);
  }
  if (auto reference = jobObject.getOptionalProperty<js::TypedArray<float>>(
          env, "referenceAudio")) {
    modelInput.referenceAudio =
        copyFloat32Pcm(env, *reference, "referenceAudio");
  }
  if (auto source = jobObject.getOptionalProperty<js::TypedArray<float>>(
          env, "sourceAudio")) {
    modelInput.sourceAudio = copyFloat32Pcm(env, *source, "sourceAudio");
  }
  if (auto value = readOptionalString(jobObject, env, "taskType"))
    modelInput.taskType = *value;
  if (auto value = readOptionalString(jobObject, env, "track"))
    modelInput.track = *value;
  if (auto value = readOptionalAcestepNumber(jobObject, env, "guidanceScale"))
    modelInput.guidanceScale = static_cast<float>(*value);
  if (auto value =
          readOptionalAcestepNumber(jobObject, env, "audioCoverStrength"))
    modelInput.audioCoverStrength = static_cast<float>(*value);
  if (auto value =
          readOptionalAcestepNumber(jobObject, env, "coverNoiseStrength"))
    modelInput.coverNoiseStrength = static_cast<float>(*value);
  if (auto value = readOptionalNumber(jobObject, env, "inferenceSteps"))
    modelInput.inferenceSteps = checkedInferenceSteps(*value);
  if (auto value = readOptionalNumber(jobObject, env, "shift"))
    modelInput.shift = checkedAcestepShift(*value);
  return modelInput;
}

inline std::string
requiredEditString(js_env_t* env, js::Object& operation, const char* key) {
  auto value =
      operation.getOptionalPropertyAs<js::String, std::string>(env, key);
  if (!value || value->empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("Edit operation '") + key + "' must be a non-empty string");
  }
  return *value;
}

inline std::string optionalEditString(
    js_env_t* env, js::Object& operation, const char* key,
    const char* fallback) {
  return operation.getOptionalPropertyAs<js::String, std::string>(env, key)
      .value_or(fallback);
}

inline double optionalEditNumber(
    js_env_t* env, js::Object& operation, const char* key, double fallback) {
  js_value_t* raw = operation.getProperty(env, key);
  if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
    return fallback;
  }
  if (!js::is<js::Number>(env, raw)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("Edit operation '") + key + "' must be a number");
  }
  const double value = js::Number::fromValue(raw).as<double>(env);
  if (!std::isfinite(value)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("Edit operation '") + key + "' must be finite");
  }
  return value;
}

inline AcestepModel::RepaintMode parseRepaintMode(const std::string& mode) {
  if (mode == "conservative") {
    return AcestepModel::RepaintMode::Conservative;
  }
  if (mode == "balanced") {
    return AcestepModel::RepaintMode::Balanced;
  }
  if (mode == "aggressive") {
    return AcestepModel::RepaintMode::Aggressive;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "Unknown repaint mode: " + mode);
}

inline AcestepModel::AudioEditOperationInput
parseEditOperation(js_env_t* env, js::Object operation) {
  const std::string operationType = requiredEditString(env, operation, "type");
  if (operationType == "flow-edit") {
    AcestepModel::FlowEditInput flow;
    flow.sourceCaption = requiredEditString(env, operation, "sourceCaption");
    flow.sourceLyrics =
        optionalEditString(env, operation, "sourceLyrics", "[Instrumental]");
    flow.targetCaption = requiredEditString(env, operation, "targetCaption");
    flow.targetLyrics =
        optionalEditString(env, operation, "targetLyrics", "[Instrumental]");
    flow.nMin =
        static_cast<float>(optionalEditNumber(env, operation, "nMin", 0.0));
    flow.nMax =
        static_cast<float>(optionalEditNumber(env, operation, "nMax", 1.0));
    flow.nAvg =
        static_cast<int>(optionalEditNumber(env, operation, "nAvg", 1.0));
    return flow;
  }
  if (operationType == "repaint") {
    AcestepModel::RepaintInput repaint;
    repaint.caption = requiredEditString(env, operation, "caption");
    repaint.lyrics =
        optionalEditString(env, operation, "lyrics", "[Instrumental]");
    repaint.start =
        static_cast<float>(optionalEditNumber(env, operation, "start", 0.0));
    repaint.end =
        static_cast<float>(optionalEditNumber(env, operation, "end", -1.0));
    repaint.strength =
        static_cast<float>(optionalEditNumber(env, operation, "strength", 0.5));
    repaint.mode = parseRepaintMode(
        optionalEditString(env, operation, "mode", "balanced"));
    return repaint;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "Unknown audio edit operation type: " + operationType);
}

inline std::vector<AcestepModel::AudioEditOperationInput>
parseEditOperations(js_env_t* env, js::Array& operations) {
  std::vector<AcestepModel::AudioEditOperationInput> result;
  result.reserve(operations.size(env));
  for (uint32_t i = 0; i < operations.size(env); ++i) {
    result.push_back(
        parseEditOperation(env, operations.get<js::Object>(env, i)));
  }
  return result;
}

inline js_value_t* createGenerationMetadata(
    js_env_t* env, const AcestepModel::GenerationMetadata& metadata) {
  auto result = js::Object::create(env);
  auto setText = [&](const char* name, const std::string& value) {
    result.setProperty(env, name, js::String::create(env, value));
  };
  auto setNumber = [&](const char* name, double value) {
    result.setProperty(env, name, js::Number::create(env, value));
  };
  setText("caption", metadata.caption);
  setText("lyrics", metadata.lyrics);
  setText("keyscale", metadata.keyscale);
  setText("vocalLanguage", metadata.vocalLanguage);
  setNumber("bpm", metadata.bpm);
  setNumber("beatsPerBar", metadata.beatsPerBar);
  setNumber("seed", static_cast<double>(metadata.seed));
  setNumber("codeFrames", metadata.codeFrames);
  if (metadata.qualityReport) {
    setText("qualityReport", *metadata.qualityReport);
  }
  return result;
}

inline js::Object createPcmChunk(
    js_env_t* env, const std::vector<int16_t>& pcm, int sampleRate,
    int channels) {
  auto result = js::Object::create(env);
  std::span<const int16_t> outputSpan(pcm.data(), pcm.size());
  result.setProperty(
      env, "outputArray", js::TypedArray<int16_t>::create(env, outputSpan));
  result.setProperty(env, "sampleRate", js::Number::create(env, sampleRate));
  result.setProperty(env, "channels", js::Number::create(env, channels));
  return result;
}

// MiniMax PCM: the sample rate and channel count come from the model.
struct JsAudioOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<int16_t>> {
  JsAudioOutputHandler(
      std::function<int()> sampleRate, std::function<int()> channels)
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<int16_t>>(
            [this, sampleRate = std::move(sampleRate),
             channels = std::move(channels)](
                const std::vector<int16_t>& data) -> js_value_t* {
              return createPcmChunk(this->env_, data, sampleRate(), channels());
            }) {}
};

// ACE-Step PCM with the LRC text and generation metadata of the same job.
struct JsGenerationOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          AcestepModel::Output> {
  JsGenerationOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            AcestepModel::Output>(
            [this](const AcestepModel::Output& out) -> js_value_t* {
              auto result = createPcmChunk(
                  this->env_, out.pcm, out.sampleRate, out.channels);
              if (!out.lrc.empty()) {
                result.setProperty(
                    this->env_, "lrc", js::String::create(this->env_, out.lrc));
              }
              if (out.metadata) {
                result.setProperty(
                    this->env_,
                    "metadata",
                    createGenerationMetadata(this->env_, *out.metadata));
              }
              return result;
            }) {}
};

struct JsUnderstandOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          AcestepModel::UnderstandOutput> {
  JsUnderstandOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            AcestepModel::UnderstandOutput>(
            [this](const AcestepModel::UnderstandOutput& u) -> js_value_t* {
              auto result = js::Object::create(this->env_);
              result.setProperty(
                  this->env_,
                  "caption",
                  js::String::create(this->env_, u.caption));
              result.setProperty(
                  this->env_, "bpm", js::Number::create(this->env_, u.bpm));
              result.setProperty(
                  this->env_,
                  "duration",
                  js::Number::create(this->env_, u.duration));
              result.setProperty(
                  this->env_,
                  "keyscale",
                  js::String::create(this->env_, u.keyscale));
              result.setProperty(
                  this->env_,
                  "timesignature",
                  js::String::create(this->env_, u.timesignature));
              result.setProperty(
                  this->env_,
                  "vocalLanguage",
                  js::String::create(this->env_, u.vocalLanguage));
              static_assert(sizeof(int) == sizeof(int32_t));
              std::span<const int32_t> codesSpan(
                  reinterpret_cast<const int32_t*>(u.audioCodes.data()),
                  u.audioCodes.size());
              result.setProperty(
                  this->env_,
                  "audioCodes",
                  js::TypedArray<int32_t>::create(this->env_, codesSpan));
              result.setProperty(
                  this->env_,
                  "seed",
                  js::Number::create(this->env_, static_cast<double>(u.seed)));
              return result;
            }) {}
};

struct JsProgressOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          AudioGenProgress> {
  JsProgressOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            AudioGenProgress>([this](const AudioGenProgress& p) -> js_value_t* {
          auto result = js::Object::create(this->env_);
          result.setProperty(
              this->env_,
              "progressStage",
              js::String::create(this->env_, p.stage));
          result.setProperty(
              this->env_,
              "progressStep",
              js::Number::create(this->env_, p.step));
          result.setProperty(
              this->env_,
              "progressTotal",
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
  const EngineType engineType =
      adapter.readEngineType(configurationParams, env);
  unique_ptr<model::IModel> model;
  function<void(function<void(const AudioGenProgress&)>)> setProgressSink;
  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;

  if (engineType == EngineType::Minimax) {
#ifdef AUDIOGEN_HAS_MINIMAX
    auto minimaxModel = make_unique<MinimaxModel>(
        adapter.buildMinimaxConfig(configurationParams, env));
    MinimaxModel* modelPtr = minimaxModel.get();
    outHandlers.add(
        make_shared<JsAudioOutputHandler>(
            [modelPtr]() { return modelPtr->sampleRate(); },
            [modelPtr]() { return modelPtr->channels(); }));
    setProgressSink = [modelPtr](function<void(const AudioGenProgress&)> sink) {
      modelPtr->setProgressSink(std::move(sink));
    };
    model = std::move(minimaxModel);
#else
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "MiniMax-Music3 is available on desktop builds only");
#endif
  } else {
    auto acestepModel = make_unique<AcestepModel>(
        adapter.buildAcestepConfig(configurationParams, env));
    AcestepModel* modelPtr = acestepModel.get();
    outHandlers.add(make_shared<JsGenerationOutputHandler>());
    outHandlers.add(make_shared<JsUnderstandOutputHandler>());
    setProgressSink = [modelPtr](function<void(const AudioGenProgress&)> sink) {
      modelPtr->setProgressSink(std::move(sink));
    };
    model = std::move(acestepModel);
  }

  outHandlers.add(make_shared<JsProgressOutputHandler>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));
  auto outputQueue = addon->addonCpp->outputQueue;
  setProgressSink([outputQueue](const AudioGenProgress& p) {
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

  if (type != "text" && type != "edit" && type != "understand") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  auto jobObject = args.getJsObject(1, "inputObj");

#ifdef AUDIOGEN_HAS_MINIMAX
  if (dynamic_cast<MinimaxModel*>(&instance.addonCpp->model.get())) {
    if (type != "text") {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          type == "understand"
              ? "MiniMax-Music3 does not support audio understanding"
              : "MiniMax-Music3 does not support audio editing");
    }
    return instance.runJob(
        std::any(buildMinimaxInput(env, jobObject, jsInput)));
  }
#endif

  AcestepModel::AnyInput modelInput =
      buildAcestepInput(env, jobObject, jsInput);
  if (type == "understand") {
    if (modelInput.sourceAudio.empty()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Audio understanding requires non-empty sourceAudio");
    }
    modelInput.understand = true;
  }
  if (type == "edit") {
    if (modelInput.sourceAudio.empty()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Audio edit requires non-empty sourceAudio");
    }
    auto operations =
        jobObject.getOptionalProperty<js::Array>(env, "editOperations");
    if (!operations || operations->size(env) == 0) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Audio edit requires at least one edit operation");
    }
    modelInput.editOperations = parseEditOperations(env, *operations);
  }
  return instance.runJob(std::any(std::move(modelInput)));
}
JSCATCH

// ── assessFit ────────────────────────────────────────────────────────────
//
// Projects one model set against the memory free right now. Args: [request],
// carrying the engine, its model files and the generation to accommodate.
// Returns a Promise of the result.
//
// Takes no instance and loads nothing: the fitters read GGUF metadata only.
// Resolves to "fits" or "does-not-fit" with the memory the load takes on each
// device, or "unknown" for a load the fitter cannot size. A model they cannot
// read, or an invalid request, rejects.
//
// The request is read into owned C++ values on the JS thread, the fitter runs
// on a worker thread with no JS access, and the result object is built back on
// the JS thread. The work reaches no model instance, so unloading or destroying
// a model while a fit runs frees nothing it reads.

inline constexpr const char* K_FIT_ENGINE_ACESTEP = "acestep";
inline constexpr const char* K_FIT_ENGINE_MINIMAX = "minimax";
inline constexpr const char* K_MINIMAX_DEVICE_AUTO = "auto";
inline constexpr const char* K_MINIMAX_DEVICE_CPU = "cpu";
inline constexpr double K_MINIMAX_FRAMES_PER_SECOND = 25.0;
inline constexpr int64_t K_MINIMAX_MIN_FRAMES = 1;

class FitRequest {
public:
  FitRequest(js_env_t* env, js::Object request)
      : env_(env), request_(request) {}

  std::string text(const char* name) {
    auto value = request_.getOptionalProperty<js::String>(env_, name);
    return value.has_value() ? value->as<std::string>(env_) : std::string();
  }

  std::optional<double> count(const char* name) {
    auto value = request_.getOptionalProperty<js::Number>(env_, name);
    if (!value.has_value()) {
      return std::nullopt;
    }
    const double raw = value->as<double>(env_);
    // A count cast from a negative or non-finite double is undefined.
    if (!std::isfinite(raw) || raw < 0) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          std::string("assessFit: ") + name + " must be a non-negative count");
    }
    return raw;
  }

  void readInt(const char* name, int& out) {
    if (auto value = count(name)) {
      out = static_cast<int>(*value);
    }
  }

  void readInt64(const char* name, int64_t& out) {
    if (auto value = count(name)) {
      out = checkedSafeInteger(*value, name);
    }
  }

  void readFloat(const char* name, float& out) {
    if (auto value = count(name)) {
      out = static_cast<float>(*value);
    }
  }

  void readBytes(const char* name, uint64_t& out) {
    if (auto value = count(name)) {
      out = static_cast<uint64_t>(*value);
    }
  }

  void readFlag(const char* name, bool& out) {
    if (auto value = request_.getOptionalProperty<js::Boolean>(env_, name)) {
      out = value->as<bool>(env_);
    }
  }

private:
  js_env_t* env_;
  js::Object request_;
};

struct FitDevice {
  std::string id;
  std::string name;
  bool unified;
  double usedBytes;
  double freeBytes;
  double totalBytes;
};

struct FitResult {
  std::string status;
  std::vector<FitDevice> devices;
};

// The PCI bus ID when the backend reports one, so the same GPU matches across
// addons built on different backends; the device name otherwise.
//
// Unified marks memory the host owns: the CPU, an integrated GPU, a GPU that
// shares host memory, Android's OpenCL GPU, and a device that reports no
// memory of its own. A unified device that reports none takes the CPU's
// figures.
inline FitDevice fitDevice(
    ggml_backend_dev_t device, const std::string& name, bool sharesHostMemory,
    uint64_t usedBytes, uint64_t freeBytes, uint64_t totalBytes) {
  std::string id = name;
  std::string deviceName = name;
  const bool reportsNoMemory = totalBytes == 0;
  bool unified = sharesHostMemory || reportsNoMemory;
  if (device != nullptr) {
    ggml_backend_dev_props props{};
    ggml_backend_dev_get_props(device, &props);
    id = props.device_id != nullptr ? props.device_id : props.name;
    deviceName = props.name;
    unified = unified || props.memory_unified ||
              props.type == GGML_BACKEND_DEVICE_TYPE_IGPU ||
              props.type == GGML_BACKEND_DEVICE_TYPE_CPU;
#if defined(__ANDROID__)
    const char* registry =
        ggml_backend_reg_name(ggml_backend_dev_backend_reg(device));
    unified = unified ||
              (registry != nullptr && std::strcmp(registry, "OpenCL") == 0);
#endif
  }
  if (unified && reportsNoMemory) {
    if (ggml_backend_dev_t host =
            ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU)) {
      size_t hostFree = 0;
      size_t hostTotal = 0;
      ggml_backend_dev_memory(host, &hostFree, &hostTotal);
      freeBytes = static_cast<uint64_t>(hostFree);
      totalBytes = static_cast<uint64_t>(hostTotal);
    }
  }
  return {
      id,
      deviceName,
      unified,
      static_cast<double>(usedBytes),
      static_cast<double>(freeBytes),
      static_cast<double>(totalBytes)};
}

// A load the fitter could not measure would still start, so it is unknown:
// MiniMax with Core ML stages, which have no memory estimate, and a failed
// measurement. A request or model file the fitter refuses rejects as an
// invalid argument, and any other failure as an internal one.
inline FitResult unsizedOrThrow(const std::string& reason) {
  if (reason == "coreml-memory-estimate-unavailable" ||
      reason == "measurement-failed") {
    return FitResult{"unknown", {}};
  }
  const bool invalid = reason == "invalid-arguments" ||
                       reason == "workload-too-large" ||
                       reason == "model-unreadable";
  throw qvac_errors::StatusError(
      invalid ? qvac_errors::general_error::InvalidArgument
              : qvac_errors::general_error::InternalError,
      "assessFit: " + reason);
}

// One row per device pool the pipeline peaks on, then the host CPU, which holds
// the CPU-placed stages, the mapped weights and the host-side buffers. Each
// figure is that pool's peak across the pipeline's phases. On the CPU the
// device pool is the host pool and both peaks measure it, so a load there is
// one row carrying that peak once.
inline FitResult toFitResult(const tts_cpp::acestep::FitResult& fit) {
  if (fit.status == tts_cpp::acestep::FitStatus::Error) {
    return unsizedOrThrow(fit.reason);
  }

  FitResult result;
  result.status = fit.status == tts_cpp::acestep::FitStatus::Success
                      ? "fits"
                      : "does-not-fit";

  ggml_backend_dev_t host =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (fit.device_is_cpu) {
    result.devices.push_back(fitDevice(
        host,
        fit.device_name,
        true,
        std::max(fit.peak_device_bytes, fit.peak_host_bytes),
        fit.host_free_bytes,
        fit.host_total_bytes));
    return result;
  }

  result.devices.push_back(fitDevice(
      ggml_backend_dev_by_name(fit.device_name.c_str()),
      fit.device_name,
      fit.device_shares_host_memory,
      fit.peak_device_bytes,
      fit.device_free_bytes,
      fit.device_total_bytes));
  for (const auto& pool : fit.extra_devices) {
    result.devices.push_back(fitDevice(
        ggml_backend_dev_by_name(pool.name.c_str()),
        pool.name,
        pool.shares_host_memory,
        pool.peak_bytes,
        pool.free_bytes,
        pool.total_bytes));
  }
  result.devices.push_back(fitDevice(
      host,
      "CPU",
      true,
      fit.peak_host_bytes,
      fit.host_free_bytes,
      fit.host_total_bytes));
  return result;
}

inline js_value_t* fitResultObject(js_env_t* env, const FitResult& fit) {
  auto result = js::Object::create(env);
  result.setProperty(env, "status", js::String::create(env, fit.status));
  auto devices = js::Array::create(env);
  for (size_t i = 0; i < fit.devices.size(); ++i) {
    const auto& row = fit.devices[i];
    auto entry = js::Object::create(env);
    entry.setProperty(env, "id", js::String::create(env, row.id));
    entry.setProperty(env, "name", js::String::create(env, row.name));
    entry.setProperty(env, "unified", js::Boolean::create(env, row.unified));
    entry.setProperty(env, "usedBytes", js::Number::create(env, row.usedBytes));
    entry.setProperty(env, "freeBytes", js::Number::create(env, row.freeBytes));
    entry.setProperty(
        env, "totalBytes", js::Number::create(env, row.totalBytes));
    devices.set(env, static_cast<uint32_t>(i), entry);
  }
  result.setProperty(env, "devices", devices);
  result.setProperty(env, "stats", js::Object::create(env));
  return result;
}

inline tts_cpp::acestep::FitOptions acestepFitOptions(FitRequest& request) {
  tts_cpp::acestep::FitOptions options;
  options.models_dir = request.text("modelsDir");
  options.text_enc_model_path = request.text("textEncoderPath");
  options.lm_model_path = request.text("lmPath");
  options.dit_model_path = request.text("ditPath");
  options.vae_model_path = request.text("vaePath");
  options.backends_dir =
      resolveBackendsDir(request.text("backendsDir")).string();
  request.readInt("gpuLayers", options.n_gpu_layers);
  request.readInt("threads", options.n_threads);
  request.readInt("textTokens", options.text_tokens);
  request.readInt("lyricTokens", options.lyric_tokens);
  request.readInt("lmPromptTokens", options.lm_prompt_tokens);
  request.readInt("lmMaxNewTokens", options.lm_max_new_tokens);
  request.readInt("keepStages", options.keep_stages);
  request.readBytes("marginBytes", options.margin_bytes);
  request.readFloat("durationSeconds", options.duration_seconds);
  request.readFloat("lmCfgScale", options.lm_cfg_scale);
  request.readFloat("guidanceScale", options.guidance_scale);
  request.readFlag("withSourceAudio", options.with_source_audio);
  return options;
}

#ifdef AUDIOGEN_HAS_MINIMAX
inline std::string minimaxFitDevice(FitRequest& request) {
  const std::string device = request.text("device");
  if (!device.empty()) {
    return device;
  }
  int gpuLayers = 0;
  request.readInt("gpuLayers", gpuLayers);
  return gpuLayers > 0 ? K_MINIMAX_DEVICE_AUTO : K_MINIMAX_DEVICE_CPU;
}

inline tts_cpp::minimax::EngineOptions minimaxFitOptions(FitRequest& request) {
  tts_cpp::minimax::EngineOptions options;
  options.model_dir = request.text("modelsDir");
  options.lm_model_path = request.text("lmPath");
  options.synth_model_path = request.text("synthPath");
  options.coreml_profile_dir = request.text("coremlProfileDir");
  options.coreml_compute_units = request.text("coremlComputeUnits");
  options.device = minimaxFitDevice(request);
  options.backends_dir =
      resolveBackendsDir(request.text("backendsDir")).string();
  request.readInt("threads", options.n_threads);
  return options;
}

inline int64_t minimaxFramesFromDuration(double seconds) {
  if (seconds <= 0) {
    return 0;
  }
  const double frames = std::round(seconds * K_MINIMAX_FRAMES_PER_SECOND);
  return std::max<int64_t>(
      K_MINIMAX_MIN_FRAMES,
      checkedSafeInteger(frames, "maxFrames derived from durationSeconds"));
}

inline tts_cpp::minimax::FitWorkload minimaxFitWorkload(FitRequest& request) {
  const auto frames = request.count("maxFrames");
  const auto seconds = request.count("durationSeconds");
  if (frames && seconds) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "assessFit: MiniMax accepts either maxFrames or durationSeconds, not "
        "both");
  }
  tts_cpp::minimax::FitWorkload workload;
  if (frames) {
    workload.max_frames = checkedSafeInteger(*frames, "maxFrames");
  }
  if (seconds) {
    workload.max_frames = minimaxFramesFromDuration(*seconds);
  }
  request.readInt64("promptTokens", workload.prompt_tokens);
  request.readBytes("marginBytes", workload.margin_bytes);
  return workload;
}
#endif

/// One engine's fit, bound to values copied out of the request, and the margin
/// it holds back.
struct FitWork {
  std::function<tts_cpp::acestep::FitResult()> run;
  uint64_t marginBytes;
};

/// Reads the request on the JS thread. The returned work owns every value it
/// needs; an invalid request throws here, before any thread starts.
inline FitWork fitWork(FitRequest& request) {
  std::string engine = request.text("engine");
  if (engine.empty() || engine == K_FIT_ENGINE_ACESTEP) {
    auto options = acestepFitOptions(request);
    return {
        [options]() { return tts_cpp::acestep::fit_params(options); },
        options.margin_bytes};
  }
#ifdef AUDIOGEN_HAS_MINIMAX
  if (engine == K_FIT_ENGINE_MINIMAX) {
    auto options = minimaxFitOptions(request);
    auto workload = minimaxFitWorkload(request);
    return {
        [options, workload]() {
          return tts_cpp::minimax::fit_params(options, workload);
        },
        workload.margin_bytes};
  }
#endif
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "assessFit: " + engine + " has no fitter in this build");
}

// The fitters register the ggml backends on first use, process-wide state two
// concurrent fits would race, so fits run one at a time. The rows read the
// devices those backends registered.
inline FitResult runFit(const FitWork& work) {
  static std::mutex fitMutex;
  const std::lock_guard<std::mutex> lock(fitMutex);
  FitResult result = toFitResult(work.run());
#if defined(__APPLE__) && TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
  // The margin the fitter held back on the device is held back from the app's
  // limit too.
  result.status = applyAppMemoryBudget(
      result.status,
      result.devices,
      static_cast<double>(os_proc_available_memory()),
      static_cast<double>(work.marginBytes));
#endif
  return result;
}

inline js_value_t* assessFit(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  FitRequest request(env, args.getJsObject(0, "request"));

  return js::JsAsyncTask::run(
      env,
      [work = fitWork(request)]() { return runFit(work); },
      fitResultObject);
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
  const EngineType engineType =
      adapter.readEngineType(configurationParams, env);

  if (engineType == EngineType::Minimax) {
#ifdef AUDIOGEN_HAS_MINIMAX
    auto newConfig = adapter.buildMinimaxConfig(configurationParams, env);
    return js::JsAsyncTask::run(
        env,
        [addonCpp = instance.addonCpp,
         newConfig = std::move(newConfig)]() mutable {
          auto* model = dynamic_cast<MinimaxModel*>(&addonCpp->model.get());
          if (model == nullptr) {
            throw qvac_errors::StatusError(
                qvac_errors::general_error::InvalidArgument,
                "reload cannot change the audiogen engine type");
          }
          model->reload(std::move(newConfig));
        });
#else
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "MiniMax-Music3 is available on desktop builds only");
#endif
  }

  auto newConfig = adapter.buildAcestepConfig(configurationParams, env);
  return js::JsAsyncTask::run(
      env,
      [addonCpp = instance.addonCpp,
       newConfig = std::move(newConfig)]() mutable {
        auto* model = dynamic_cast<AcestepModel*>(&addonCpp->model.get());
        if (model == nullptr) {
          throw qvac_errors::StatusError(
              qvac_errors::general_error::InvalidArgument,
              "reload cannot change the audiogen engine type");
        }
        model->setConfig(std::move(newConfig));
        model->reload();
      });
}
JSCATCH

} // namespace qvac::audiogenggml::addon_js

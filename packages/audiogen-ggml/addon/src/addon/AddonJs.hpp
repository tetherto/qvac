#pragma once

#include <any>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
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

#include "js-interface/JSAdapter.hpp"
#include "model-interface/AudioGenProgress.hpp"
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
inline constexpr int K_MAXIMUM_MINIMAX_INFERENCE_STEPS = 1000;

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

inline int checkedMinimaxInferenceSteps(double value) {
  const int64_t integer = checkedSafeInteger(value, "inferenceSteps");
  if (integer < 0 || integer > K_MAXIMUM_MINIMAX_INFERENCE_STEPS) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "inferenceSteps must be between 0 and 1000");
  }
  return static_cast<int>(integer);
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
    modelInput.inferenceSteps = checkedMinimaxInferenceSteps(*value);
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
  if (auto value = readOptionalAcestepNumber(jobObject, env, "seed"))
    modelInput.seed = static_cast<long long>(*value);
  if (auto value = readOptionalAcestepNumber(jobObject, env, "bpm"))
    modelInput.bpm = static_cast<int>(*value);
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
  if (auto value = readOptionalBoolean(jobObject, env, "normalizeLoudness"))
    modelInput.normalizeLoudness = *value;
  if (auto value = readOptionalBoolean(jobObject, env, "computeQualityScore"))
    modelInput.computeQualityScore = *value;
  if (auto value = readOptionalBoolean(jobObject, env, "dcwEnabled"))
    modelInput.dcwEnabled = *value;
  if (auto value = readOptionalAcestepNumber(jobObject, env, "dcwScaler"))
    modelInput.dcwScaler = static_cast<float>(*value);
  if (auto value = readOptionalAcestepNumber(jobObject, env, "dcwHighScaler"))
    modelInput.dcwHighScaler = static_cast<float>(*value);
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
              auto result = js::Object::create(this->env_);
              std::span<const int16_t> outputSpan(data.data(), data.size());
              auto typedArray =
                  js::TypedArray<int16_t>::create(this->env_, outputSpan);
              result.setProperty(this->env_, "outputArray", typedArray);
              result.setProperty(
                  this->env_,
                  "sampleRate",
                  js::Number::create(this->env_, sampleRate()));
              result.setProperty(
                  this->env_,
                  "channels",
                  js::Number::create(this->env_, channels()));
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
  function<int()> sampleRate;
  function<int()> channels;
  function<void(function<void(const AudioGenProgress&)>)> setProgressSink;

  if (engineType == EngineType::Minimax) {
#ifdef AUDIOGEN_HAS_MINIMAX
    auto minimaxModel = make_unique<MinimaxModel>(
        adapter.buildMinimaxConfig(configurationParams, env));
    MinimaxModel* modelPtr = minimaxModel.get();
    sampleRate = [modelPtr]() { return modelPtr->sampleRate(); };
    channels = [modelPtr]() { return modelPtr->channels(); };
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
    sampleRate = [modelPtr]() { return modelPtr->sampleRate(); };
    channels = [modelPtr]() { return modelPtr->channels(); };
    setProgressSink = [modelPtr](function<void(const AudioGenProgress&)> sink) {
      modelPtr->setProgressSink(std::move(sink));
    };
    model = std::move(acestepModel);
  }

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(
      make_shared<JsAudioOutputHandler>(
          std::move(sampleRate), std::move(channels)));
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

  if (type != "text" && type != "edit") {
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
          "MiniMax-Music3 does not support audio editing");
    }
    return instance.runJob(
        std::any(buildMinimaxInput(env, jobObject, jsInput)));
  }
#endif

  AcestepModel::AnyInput modelInput =
      buildAcestepInput(env, jobObject, jsInput);
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

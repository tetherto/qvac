#pragma once

#include "JsUtils.hpp"
#include <string>

namespace qvac_lib_inference_addon_cpp {
struct FinetuningParameters
{
  FinetuningParameters(js_env_t* env, js::Object finetuningParametersObj) :
    outputParametersDir(finetuningParametersObj.getProperty<js::String>(env, "outputParametersDir").as<std::string>(env)),
    numberOfEpochs(finetuningParametersObj.getProperty<js::Uint32>(env, "numberOfEpochs").as<uint32_t>(env)),
    learningRate(finetuningParametersObj.getProperty<js::Number>(env, "learningRate").as<double>(env)),
    trainDatasetDir(finetuningParametersObj.getProperty<js::String>(env, "trainDatasetDir").as<std::string>(env)),
    evalDatasetDir(finetuningParametersObj.getOptionalPropertyAs<js::String, std::string>(env, "evalDatasetDir").value_or("")),
    evalDatasetPath(finetuningParametersObj.getOptionalPropertyAs<js::String, std::string>(env, "evalDatasetPath").value_or("")),
    contextLength(finetuningParametersObj.getOptionalPropertyAs<js::Number, int64_t>(env, "contextLength").value_or(0)),
    microBatchSize(finetuningParametersObj.getOptionalPropertyAs<js::Number, int64_t>(env, "microBatchSize").value_or(0)),
    assistantLossOnly(finetuningParametersObj.getOptionalPropertyAs<js::Boolean, bool>(env, "assistantLossOnly").value_or(false)),
    checkpointSaveDir(finetuningParametersObj.getOptionalPropertyAs<js::String, std::string>(env, "checkpointSaveDir").value_or("")),
    loraModules(finetuningParametersObj.getOptionalPropertyAs<js::String, std::string>(env, "loraModules").value_or("")),
    loraRank(finetuningParametersObj.getOptionalPropertyAs<js::Number, int32_t>(env, "loraRank").value_or(8)),
    loraAlpha(finetuningParametersObj.getOptionalPropertyAs<js::Number, double>(env, "loraAlpha").value_or(16.0)),
    loraDropout(finetuningParametersObj.getOptionalPropertyAs<js::Number, double>(env, "loraDropout").value_or(0.0)),
    loraInitStd(finetuningParametersObj.getOptionalPropertyAs<js::Number, double>(env, "loraInitStd").value_or(0.01)),
    chatTemplatePath(finetuningParametersObj.getOptionalPropertyAs<js::String, std::string>(env, "chatTemplatePath").value_or("")),
    checkpointSaveSteps(finetuningParametersObj.getOptionalPropertyAs<js::Number, int64_t>(env, "checkpointSaveSteps").value_or(0)),
    lrMin(finetuningParametersObj.getOptionalPropertyAs<js::Number, double>(env, "lrMin").value_or(0.0)),
    lrScheduler(finetuningParametersObj.getOptionalPropertyAs<js::String, std::string>(env, "lrScheduler").value_or("constant")),
    warmupRatio(finetuningParametersObj.getOptionalPropertyAs<js::Number, double>(env, "warmupRatio").value_or(0.0)),
    batchSize(finetuningParametersObj.getOptionalPropertyAs<js::Number, int64_t>(env, "batchSize").value_or(0)),
    weightDecay(finetuningParametersObj.getOptionalPropertyAs<js::Number, double>(env, "weightDecay").value_or(0.0)),
    warmupStepsSet(finetuningParametersObj.getOptionalPropertyAs<js::Boolean, bool>(env, "warmupStepsSet").value_or(false)),
    warmupSteps(finetuningParametersObj.getOptionalPropertyAs<js::Number, int64_t>(env, "warmupSteps").value_or(0)),
    warmupRatioSet(finetuningParametersObj.getOptionalPropertyAs<js::Boolean, bool>(env, "warmupRatioSet").value_or(false)),
    validationSplit(finetuningParametersObj.getOptionalPropertyAs<js::Number, double>(env, "validationSplit").value_or(0.05)),
    useEvalDatasetForValidation(finetuningParametersObj.getOptionalPropertyAs<js::Boolean, bool>(env, "useEvalDatasetForValidation").value_or(false))
  {}
  FinetuningParameters() = default;

  std::string outputParametersDir;
  int numberOfEpochs{0};
  double learningRate{0.0};
  std::string trainDatasetDir;
  std::string evalDatasetDir;
  std::string evalDatasetPath;
  int64_t contextLength{0};
  int64_t microBatchSize{0};
  bool assistantLossOnly{false};
  std::string checkpointSaveDir;
  std::string loraModules;
  int32_t loraRank{8};
  double loraAlpha{16.0};
  double loraDropout{0.0};
  double loraInitStd{0.01};
  std::string chatTemplatePath;
  int64_t checkpointSaveSteps{0};
  double lrMin{0.0};
  std::string lrScheduler;
  double warmupRatio{0.0};
  int64_t batchSize{0};
  double weightDecay{0.0};
  bool warmupStepsSet{false};
  int64_t warmupSteps{0};
  bool warmupRatioSet{false};
  double validationSplit{0.05};
  bool useEvalDatasetForValidation{false};
};

}

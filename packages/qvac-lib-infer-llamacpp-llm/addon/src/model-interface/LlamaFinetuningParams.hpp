#pragma once

#include <cstdint>
#include <string>

namespace qvac_lib_inference_addon_llama {

struct LlamaFinetuningParams {
  std::string outputParametersDir;
  int numberOfEpochs{0};
  double learningRate{0.0};
  std::string trainDatasetDir;
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
  std::string lrScheduler{"constant"};
  double warmupRatio{0.0};
  int64_t batchSize{0};
  double weightDecay{0.0};
  bool warmupStepsSet{false};
  int64_t warmupSteps{0};
  bool warmupRatioSet{false};
  double validationSplit{0.05};
  bool useEvalDatasetForValidation{false};
};

} // namespace qvac_lib_inference_addon_llama

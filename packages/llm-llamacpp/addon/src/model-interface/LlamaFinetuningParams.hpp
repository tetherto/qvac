#pragma once

#include <cstdint>
#include <string>

namespace qvac_lib_inference_addon_llama {

struct LlamaFinetuningParams {
  std::string outputParametersDir;
  int numberOfEpochs{1};
  double learningRate{1e-4};
  std::string trainDatasetDir;
  std::string evalDatasetPath;
  int64_t contextLength{128};
  int64_t microBatchSize{128};
  bool assistantLossOnly{false};
  std::string checkpointSaveDir;
  std::string loraModules;
  int32_t loraRank{8};
  double loraAlpha{16.0};
  double loraInitStd{0.02};
  uint32_t loraSeed{42};
  std::string chatTemplatePath;
  int64_t checkpointSaveSteps{0};
  double lrMin{0.0};
  std::string lrScheduler{"cosine"};
  double warmupRatio{0.1};
  int64_t batchSize{128};
  double weightDecay{0.01};
  bool warmupStepsSet{false};
  int64_t warmupSteps{0};
  bool warmupRatioSet{false};
  double validationSplit{0.05};
  bool useEvalDatasetForValidation{false};
  bool flashAttn{false};
};

} // namespace qvac_lib_inference_addon_llama

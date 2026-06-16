#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include <ggml-opt.h>
#include <llama.h>

#include "LlamaFinetuningHelpers.hpp"
#include "LlamaFinetuningParams.hpp"

class LlamaModel;

struct FinetuneTerminalResult {
  struct Stats {
    double trainLoss = 0.0;
    double trainLossUncertainty = 0.0;
    double valLoss = 0.0;
    double valLossUncertainty = 0.0;
    double trainAccuracy = 0.0;
    double trainAccuracyUncertainty = 0.0;
    double valAccuracy = 0.0;
    double valAccuracyUncertainty = 0.0;
    double learningRate = 0.0;
    int64_t globalSteps = 0;
    int32_t epochsCompleted = 0;
  };

  std::string op;
  std::string status;
  std::optional<Stats> stats;
};

/// @brief Owns the LoRA finetuning pipeline and pause/resume checkpoint
/// state for a single `LlamaModel`. Construction stores a reference to the
/// owning model; the model must outlive the finetuner (guaranteed by
/// composition).
class LlamaFinetuner {
public:
  using ProgressCallback = std::function<void(
      const llama_finetuning_helpers::FinetuneProgressStats&)>;

  explicit LlamaFinetuner(LlamaModel& model) : model_(model) {}
  ~LlamaFinetuner() = default;

  LlamaFinetuner(const LlamaFinetuner&) = delete;
  LlamaFinetuner& operator=(const LlamaFinetuner&) = delete;
  LlamaFinetuner(LlamaFinetuner&&) = delete;
  LlamaFinetuner& operator=(LlamaFinetuner&&) = delete;

  std::string finetune(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      FinetuneTerminalResult::Stats* outStats = nullptr,
      ProgressCallback progressCallback = nullptr);

  bool isFinetuneRunning() const;
  bool requestPause(bool savePauseCheckpoint = true);
  void clearPauseRequest();

  /// Block until the training thread has completed the finetuning pause path.
  void waitUntilFinetuningPauseComplete();

private:
  void validateModelForFinetuning();
  void validateFinetuningParams(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);
  ggml_opt_dataset_t prepareTrainingDataset(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);
  ggml_opt_dataset_t prepareEvalDataset(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);
  ggml_opt_dataset_t prepareDatasetFromPath(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      const std::string& datasetPath, const char* errorLabel,
      const char* constructKind);
  void initializeLoraAdapter(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      uint32_t targetModules, llama_adapter_lora*& adapter);
  llama_finetuning_helpers::LoraLrSchedulerState createLrScheduler(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      int64_t totalSteps);
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
  initializeCheckpointing(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      llama_adapter_lora* adapter,
      llama_finetuning_helpers::LoraLrSchedulerState* scheduler);
  void configureOptimizer(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      llama_adapter_lora* adapter,
      llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
      llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
      bool loadOptimizerState = false);
  void executeTrainingLoop(
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
      ggml_opt_dataset_t dataset, int64_t trainSplit, int64_t evalSplit,
      llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
      llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
      uint32_t startEpoch = 0, bool resumingFromPause = false,
      ggml_opt_dataset_t evalDataset = nullptr,
      int64_t evalDatasetSampleCount = 0,
      FinetuneTerminalResult::Stats* outStats = nullptr);
  void saveLoraAdapter(
      llama_adapter_lora* adapter,
      const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);

  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
  getCurrentCheckpointStateShared() const;
  void setCurrentCheckpointStateShared(
      std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState> state);
  void clearCurrentCheckpointStateShared();
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
  getPausedCheckpointStateShared() const;
  void setPausedCheckpointStateShared(
      std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState> state);
  void clearPausedCheckpointStateShared();

  LlamaModel& model_;

  mutable std::mutex checkpointStateMutex_;
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
      currentCheckpointState_;
  std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
      pausedCheckpointState_;
};

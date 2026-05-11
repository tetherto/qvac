#pragma once

#include <atomic>
#include <condition_variable>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include <ggml-opt.h>
#include <llama.h>

#include "LlamaFinetuningParams.hpp"

namespace llama_finetuning_helpers {

// Types and Enums
enum class LoraLrScheduleType : std::uint8_t {
  Constant,
  Cosine,
  Linear,
};

struct LoraLrSchedulerState {
  LoraLrScheduleType schedule = LoraLrScheduleType::Constant;
  float lrInit = 1e-5f;
  float lrMin = 0.0f;
  float weightDecay = 0.0f;
  int64_t totalSteps = 0;
  int64_t currentStep = 0;
  float lastLr = 0.0f;
  float warmupRatio = 0.0f;
  int64_t warmupSteps = 0;
};

struct CheckpointMetadata {
  int32_t epoch = 0;
  int32_t loraRank = 0;
  float loraAlpha = 0.0f;
  uint32_t targetModules = 0;
  int64_t globalStep = 0;
  int64_t currentStep = 0; // Scheduler step
  int32_t resumeEpoch = -1;
  int64_t resumeBatch = -1; // idata batch index for llama_opt_epoch_resume
  bool pausedDuringValidation = false;
};

struct FinetuneProgressStats {
  bool isTrain = true;
  double loss = 0.0;
  double lossUncertainty = 0.0;
  double accuracy = 0.0;
  double accuracyUncertainty = 0.0;
  int64_t globalSteps = 0;
  int32_t currentEpoch = 0;
  int64_t currentBatch = 0;
  int64_t totalBatches = 0;
  int64_t elapsedMs = 0;
  int64_t etaMs = 0;
};

struct TrainingCheckpointState {
  llama_context* ctx = nullptr;
  llama_model* model = nullptr;
  llama_adapter_lora* adapter = nullptr;
  std::filesystem::path checkpointDir;
  int64_t checkpointInterval = 0;
  int64_t globalStep = 0;
  int32_t currentEpoch = 0;
  int32_t loraRank = 0;
  float loraAlpha = 0.0f;
  uint32_t targetModules = 0;
  LoraLrSchedulerState* scheduler = nullptr;
  std::atomic<bool> pauseRequested{false};
  std::atomic<bool> shouldExit{false};
  std::atomic<bool> pauseCheckpointSaved{false};
  std::filesystem::path pauseCheckpointPath;
  std::atomic<bool> isIdle{true};
  std::atomic<bool> isFinetuning{false};
  std::atomic<bool> isPaused{false};
  int64_t expectedFirstBatchAfterResume = -1;
  bool firstBatchAfterResumeLogged = false;
  int64_t batchOffsetWithinEpoch = -1;
  int64_t resumeGlobalStepSkip = 0;
  bool finetuningStartedEmitted = false;
  bool suppressProgressBar = false;
  std::function<void(const FinetuneProgressStats&)> progressCallback;

  std::mutex pauseDoneMutex;
  std::condition_variable pauseDoneCv;
  std::atomic<bool> pauseWaitDone{false};

  void setIdle() {
    isIdle.store(true);
    isFinetuning.store(false);
    isPaused.store(false);
  }
};

// Dataset preparation functions
std::string readTextFile(const std::string& path);
std::vector<llama_token>
tokenizeDataset(llama_context* ctx, const std::string& filePath);
ggml_opt_dataset_t buildNextTokenDataset(
    const std::vector<llama_token>& tokens, int64_t sequenceLength,
    int64_t stride);

// LoRA configuration functions
uint32_t parseLoraModules(const std::string& modulesStr);

// Learning rate scheduling functions
bool parseLrScheduler(const std::string& name, LoraLrScheduleType& outType);
float schedulerLrForStep(const LoraLrSchedulerState& state, int64_t step);
ggml_opt_optimizer_params schedulerOptimizerParams(void* userdata);

// Checkpoint management functions
std::filesystem::path
checkpointStepDirectory(const TrainingCheckpointState& state, int64_t step);
void saveCheckpoint(ggml_opt_context_t optCtx, TrainingCheckpointState& state);
bool parseCheckpointMetadata(
    const std::filesystem::path& metadataPath, CheckpointMetadata& meta);
std::filesystem::path pauseCheckpointDirectory(
    const std::filesystem::path& checkpointDir, int64_t step);
std::filesystem::path
findLatestPauseCheckpoint(const std::filesystem::path& checkpointDir);
void savePauseCheckpoint(
    ggml_opt_context_t optCtx, TrainingCheckpointState& state,
    bool pausedDuringValidation = false, int64_t ibatch = -1);
bool tryHandlePauseRequest(
    ggml_opt_context_t optCtx, TrainingCheckpointState* state, bool train,
    int64_t ibatch, int64_t ibatchMax);
bool loadPauseCheckpoint(
    const std::filesystem::path& checkpointPath, llama_adapter_lora* adapter,
    llama_model* model, llama_context* ctx, ggml_opt_context_t* optCtx,
    CheckpointMetadata& meta);
bool pauseCheckpointExists(const std::filesystem::path& checkpointDir);
void clearPauseCheckpoint(const std::filesystem::path& checkpointDir);
void optEpochCallback(
    bool train, ggml_opt_context_t optCtx, ggml_opt_dataset_t dataset,
    ggml_opt_result_t result, int64_t ibatch, int64_t ibatchMax,
    int64_t tStartUs, TrainingCheckpointState* checkpointState);

void optEpochCallbackWrapper(
    bool train, ggml_opt_context_t optCtx, ggml_opt_dataset_t dataset,
    ggml_opt_result_t result, int64_t ibatch, int64_t ibatchMax,
    int64_t tStartUs);

void setCurrentCheckpointState(TrainingCheckpointState* state);
void clearCurrentCheckpointState();

// Utility functions
std::string resolveAdapterOutputPath(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params);

} // namespace llama_finetuning_helpers

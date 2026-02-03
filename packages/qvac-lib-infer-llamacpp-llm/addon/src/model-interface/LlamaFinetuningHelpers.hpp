#pragma once

#include <atomic>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

#include <ggml-opt.h>
#include <llama.h>

// Forward declaration to avoid pulling in Bare runtime dependencies
namespace qvac_lib_inference_addon_cpp {
struct FinetuningParameters;
}

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
  std::function<void(const std::string&)> logFn;
  // Pause/resume control
  std::atomic<bool> pauseRequested{false};
  std::atomic<bool> shouldExit{false};
  std::atomic<bool> pauseCheckpointSaved{
      false}; // Flag to prevent multiple saves
  std::filesystem::path pauseCheckpointPath;
  // Resume verification
  int64_t expectedFirstBatchAfterResume =
      -1; // Set when resuming to verify first batch
  bool firstBatchAfterResumeLogged =
      false; // Track if we've logged the first batch
  // Mid-epoch resume support
  int64_t batchOffsetWithinEpoch =
      -1; // Batch index within epoch to resume from (0-indexed), -1 means start
          // from beginning
  bool skippingBatches =
      false; // Track if we're currently skipping batches to reach resume point
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
bool saveCheckpoint(ggml_opt_context_t optCtx, TrainingCheckpointState& state);
bool parseCheckpointMetadata(
    const std::filesystem::path& metadataPath, CheckpointMetadata& meta);
std::filesystem::path pauseCheckpointDirectory(
    const std::filesystem::path& checkpointDir, int64_t step);
std::filesystem::path
findLatestPauseCheckpoint(const std::filesystem::path& checkpointDir);
bool savePauseCheckpoint(
    ggml_opt_context_t optCtx, TrainingCheckpointState& state);
bool loadPauseCheckpoint(
    const std::filesystem::path& checkpointPath, llama_adapter_lora* adapter,
    llama_model* model, llama_context* ctx, ggml_opt_context_t* optCtx,
    CheckpointMetadata& meta);
// Note: optCtx parameter is kept for API compatibility but optimizer loading
// is handled separately via llama_opt_init with checkpoint_path parameter
bool pauseCheckpointExists(const std::filesystem::path& checkpointDir);
void clearPauseCheckpoint(const std::filesystem::path& checkpointDir);
void optEpochCallback(
    bool train, ggml_opt_context_t optCtx, ggml_opt_dataset_t dataset,
    ggml_opt_result_t result, int64_t ibatch, int64_t ibatchMax,
    int64_t tStartUs, TrainingCheckpointState* checkpointState);

// Wrapper for callback that uses global state (for compatibility)
void optEpochCallbackWrapper(
    bool train, ggml_opt_context_t optCtx, ggml_opt_dataset_t dataset,
    ggml_opt_result_t result, int64_t ibatch, int64_t ibatchMax,
    int64_t tStartUs);

// Global checkpoint state management (for callback compatibility)
void setGlobalCheckpointState(TrainingCheckpointState* state);
TrainingCheckpointState* getGlobalCheckpointState();
void clearGlobalCheckpointState();

// Utility functions
std::string resolveAdapterOutputPath(
    const qvac_lib_inference_addon_cpp::FinetuningParameters& params);

} // namespace llama_finetuning_helpers

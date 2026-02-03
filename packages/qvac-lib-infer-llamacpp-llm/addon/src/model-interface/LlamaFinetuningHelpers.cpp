#include "LlamaFinetuningHelpers.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <unordered_map>
#include <vector>

#include <common/common.h>
#include <common/log.h>
#include <ggml-opt.h>
#ifndef STANDALONE_TEST_BUILD
#include <qvac-lib-inference-addon-cpp/FinetuningParameters.hpp>
#endif

namespace llama_finetuning_helpers {

// Global checkpoint state for callback (thread-local would be better but this
// matches current implementation)
static TrainingCheckpointState* gTrainingCheckpointState = nullptr;

std::string readTextFile(const std::string& path) {
  std::ifstream stream(path, std::ios::in | std::ios::binary);
  if (!stream) {
    throw std::runtime_error("Unable to open dataset file: " + path);
  }
  std::ostringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

std::vector<llama_token>
tokenizeDataset(llama_context* ctx, const std::string& filePath) {
  const auto fileContents = readTextFile(filePath);
  return common_tokenize(ctx, fileContents, true);
}

ggml_opt_dataset_t buildNextTokenDataset(
    const std::vector<llama_token>& tokens, int64_t sequenceLength,
    int64_t stride) {
  if (sequenceLength <= 0) {
    throw std::runtime_error(
        "Sequence length must be positive for finetuning dataset");
  }

  if (stride <= 0) {
    throw std::runtime_error("Dataset stride must be positive");
  }

  const int64_t tokenCount = static_cast<int64_t>(tokens.size());
  if (tokenCount <= sequenceLength + 1) {
    throw std::runtime_error(
        "Dataset is too small for the selected context length");
  }

  const int64_t maxOffset = tokenCount - sequenceLength - 1;
  const int64_t sampleCount = maxOffset / stride;
  if (sampleCount <= 0) {
    throw std::runtime_error(
        "No finetune samples available after applying stride");
  }
  ggml_opt_dataset_t dataset = ggml_opt_dataset_init(
      GGML_TYPE_I32,
      GGML_TYPE_I32,
      sequenceLength,
      sequenceLength,
      sampleCount,
      int64_t{1});

  if (dataset == nullptr) {
    throw std::runtime_error("Failed to allocate finetuning dataset");
  }

  auto* dataTensor = ggml_opt_dataset_data(dataset);
  auto* labelsTensor = ggml_opt_dataset_labels(dataset);

  auto* dataBase = static_cast<int32_t*>(dataTensor->data);
  auto* labelsBase = static_cast<int32_t*>(labelsTensor->data);

  const int64_t dataStrideToken =
      dataTensor->nb[0] / static_cast<int64_t>(sizeof(int32_t));
  const int64_t dataStrideSample =
      dataTensor->nb[1] / static_cast<int64_t>(sizeof(int32_t));
  const int64_t labelStrideToken =
      labelsTensor->nb[0] / static_cast<int64_t>(sizeof(int32_t));
  const int64_t labelStrideSample =
      labelsTensor->nb[1] / static_cast<int64_t>(sizeof(int32_t));

  for (int64_t sample = 0; sample < sampleCount; ++sample) {
    const int64_t tokenOffset = sample * stride;
    for (int64_t t = 0; t < sequenceLength; ++t) {
      dataBase[t * dataStrideToken + sample * dataStrideSample] =
          tokens[static_cast<size_t>(tokenOffset + t)];
      labelsBase[t * labelStrideToken + sample * labelStrideSample] =
          tokens[static_cast<size_t>(tokenOffset + t + 1)];
    }
  }

  return dataset;
}

uint32_t parseLoraModules(const std::string& modulesStr) {
  if (modulesStr.empty()) {
    return LLAMA_LORA_TARGET_ATTN_Q | LLAMA_LORA_TARGET_ATTN_K |
           LLAMA_LORA_TARGET_ATTN_V | LLAMA_LORA_TARGET_ATTN_O;
  }

  static const std::unordered_map<std::string, uint32_t> kModuleMap = {
      {"attn_q", LLAMA_LORA_TARGET_ATTN_Q},
      {"attn_k", LLAMA_LORA_TARGET_ATTN_K},
      {"attn_v", LLAMA_LORA_TARGET_ATTN_V},
      {"attn_o", LLAMA_LORA_TARGET_ATTN_O},
      {"ffn_gate", LLAMA_LORA_TARGET_FFN_GATE},
      {"ffn_up", LLAMA_LORA_TARGET_FFN_UP},
      {"ffn_down", LLAMA_LORA_TARGET_FFN_DOWN},
      {"output", LLAMA_LORA_TARGET_OUTPUT},
      {"all", LLAMA_LORA_TARGET_ALL}};

  uint32_t mask = 0;
  std::stringstream ss(modulesStr);
  std::string token;
  while (std::getline(ss, token, ',')) {
    token.erase(0, token.find_first_not_of(" \t"));
    token.erase(token.find_last_not_of(" \t") + 1);
    if (token.empty()) {
      continue;
    }
    auto it = kModuleMap.find(token);
    if (it == kModuleMap.end()) {
      throw std::runtime_error("Unknown LoRA target module: " + token);
    }
    mask |= it->second;
  }

  return mask;
}

bool parseLrScheduler(const std::string& name, LoraLrScheduleType& outType) {
  auto lower = name;
  std::transform(
      lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
      });
  if (lower == "constant") {
    outType = LoraLrScheduleType::Constant;
    return true;
  }
  if (lower == "cosine") {
    outType = LoraLrScheduleType::Cosine;
    return true;
  }
  if (lower == "linear") {
    outType = LoraLrScheduleType::Linear;
    return true;
  }
  return false;
}

float schedulerLrForStep(const LoraLrSchedulerState& state, int64_t step) {
  if (state.totalSteps <= 0) {
    return std::max(state.lrInit, 0.0f);
  }

  const int64_t clampedStep = std::clamp<int64_t>(step, 0, state.totalSteps);
  const int64_t warmupSteps =
      std::clamp<int64_t>(state.warmupSteps, 0, state.totalSteps);

  if (warmupSteps > 0 && clampedStep < warmupSteps) {
    const float warmupProgress =
        static_cast<float>(clampedStep) / static_cast<float>(warmupSteps);
    return std::max(state.lrInit * warmupProgress, 0.0f);
  }

  const int64_t adjustedStep = clampedStep - warmupSteps;
  int64_t remainingSteps = state.totalSteps - warmupSteps;
  if (remainingSteps <= 0) {
    remainingSteps = 1;
  }

  const float progress = std::min<float>(
      static_cast<float>(adjustedStep) / static_cast<float>(remainingSteps),
      1.0f);

  switch (state.schedule) {
  case LoraLrScheduleType::Constant:
    return std::max(state.lrInit, 0.0f);
  case LoraLrScheduleType::Cosine: {
    constexpr float kPi = 3.14159265358979323846f;
    const float cosine = 0.5f * (1.0f + std::cos(progress * kPi));
    return std::max(state.lrMin + (state.lrInit - state.lrMin) * cosine, 0.0f);
  }
  case LoraLrScheduleType::Linear:
    return std::max(
        state.lrInit + (state.lrMin - state.lrInit) * progress, 0.0f);
  }
  return std::max(state.lrInit, 0.0f);
}

ggml_opt_optimizer_params schedulerOptimizerParams(void* userdata) {
  auto* state = static_cast<LoraLrSchedulerState*>(userdata);
  auto params = ggml_opt_get_default_optimizer_params(nullptr);
  const float lr = schedulerLrForStep(*state, state->currentStep + 1);
  state->lastLr = lr;
  params.adamw.alpha = lr;
  params.adamw.wd = state->weightDecay;
  params.sgd.alpha = lr;
  params.sgd.wd = state->weightDecay;
  if (state->currentStep < state->totalSteps) {
    state->currentStep++;
  }
  return params;
}

std::filesystem::path
checkpointStepDirectory(const TrainingCheckpointState& state, int64_t step) {
  std::ostringstream name;
  name << "checkpoint_step_" << std::setfill('0') << std::setw(8) << step;
  return state.checkpointDir / name.str();
}

std::filesystem::path pauseCheckpointDirectory(
    const std::filesystem::path& checkpointDir, int64_t step) {
  std::ostringstream name;
  name << "pause_checkpoint_step_" << std::setfill('0') << std::setw(8) << step;
  return checkpointDir / name.str();
}

std::filesystem::path
findLatestPauseCheckpoint(const std::filesystem::path& checkpointDir) {
  std::filesystem::path latestPath;
  int64_t latestStep = -1;

  if (!std::filesystem::exists(checkpointDir) ||
      !std::filesystem::is_directory(checkpointDir)) {
    return latestPath; // Return empty path if directory doesn't exist
  }

  // Scan for all pause_checkpoint_step_* directories
  for (const auto& entry : std::filesystem::directory_iterator(checkpointDir)) {
    if (!entry.is_directory()) {
      continue;
    }

    const std::string dirName = entry.path().filename().string();
    const std::string prefix = "pause_checkpoint_step_";

    // Check if directory matches pattern
    if (dirName.size() > prefix.size() &&
        dirName.substr(0, prefix.size()) == prefix) {
      // Extract step number from directory name
      const std::string stepStr = dirName.substr(prefix.size());
      try {
        int64_t step = std::stoll(stepStr);
        if (step > latestStep) {
          latestStep = step;
          latestPath = entry.path();
        }
      } catch (const std::exception&) {
        // Invalid step number, skip this directory
        continue;
      }
    }
  }

  return latestPath; // Returns empty path if no pause checkpoint found
}

bool saveCheckpoint(ggml_opt_context_t optCtx, TrainingCheckpointState& state) {
  if (state.checkpointInterval <= 0 || state.adapter == nullptr ||
      state.ctx == nullptr || state.model == nullptr) {
    return false;
  }

  const int64_t step = state.globalStep;
  const auto stepDir = checkpointStepDirectory(state, step);
  std::error_code ec;
  std::filesystem::create_directories(stepDir, ec);
  if (ec) {
    if (state.logFn) {
      std::ostringstream msg;
      msg << "Checkpoint save skipped at step " << step
          << " | directory error: " << ec.message();
      state.logFn(msg.str());
    }
    return false;
  }

  const std::string stepDirStr = stepDir.string();
  if (!llama_lora_save_checkpoint(
          state.adapter, stepDirStr.c_str(), state.model, state.ctx)) {
    if (state.logFn) {
      std::ostringstream msg;
      msg << "Failed to save LoRA checkpoint at step " << step << " in "
          << stepDirStr;
      state.logFn(msg.str());
    }
    return false;
  }

  const auto optimizerPath = stepDir / "optimizer.gguf";
  if (!ggml_opt_save_state(optCtx, optimizerPath.string().c_str())) {
    if (state.logFn) {
      std::ostringstream msg;
      msg << "Unable to save optimizer state alongside checkpoint at step "
          << step;
      state.logFn(msg.str());
    }
  }

  const auto metadataPath = stepDir / "metadata.json";
  std::ofstream metadata(metadataPath);
  if (metadata.is_open()) {
    CheckpointMetadata meta{};
    meta.epoch = state.currentEpoch;
    meta.loraRank = state.loraRank;
    meta.loraAlpha = state.loraAlpha;
    meta.targetModules = state.targetModules;
    meta.globalStep = state.globalStep;
    meta.currentStep = state.scheduler ? state.scheduler->currentStep : 0;

    metadata << "epoch=" << meta.epoch << '\n';
    metadata << "lora_rank=" << meta.loraRank << '\n';
    metadata << std::fixed << std::setprecision(6);
    metadata << "lora_alpha=" << meta.loraAlpha << '\n';
    metadata << "target_modules=" << meta.targetModules << '\n';
    metadata << "global_step=" << meta.globalStep << '\n';
    metadata << "current_step=" << meta.currentStep << '\n';
  } else if (state.logFn) {
    std::ostringstream msg;
    msg << "Checkpoint metadata write failed at step " << step;
    state.logFn(msg.str());
  }

  // Note: Checkpoint save is already logged by llama.cpp's progress bar
  // callback (ggml_opt_epoch_callback_progress_bar), so we don't duplicate the
  // log here

  return true;
}

bool parseCheckpointMetadata(
    const std::filesystem::path& metadataPath, CheckpointMetadata& meta) {
  if (!std::filesystem::exists(metadataPath)) {
    return false;
  }

  std::ifstream metadata(metadataPath);
  if (!metadata.is_open()) {
    return false;
  }

  std::string line;
  while (std::getline(metadata, line)) {
    const size_t eqPos = line.find('=');
    if (eqPos == std::string::npos) {
      continue;
    }

    std::string key = line.substr(0, eqPos);
    std::string value = line.substr(eqPos + 1);

    if (key == "epoch") {
      meta.epoch = std::stoi(value);
    } else if (key == "lora_rank") {
      meta.loraRank = std::stoi(value);
    } else if (key == "lora_alpha") {
      meta.loraAlpha = std::stof(value);
    } else if (key == "target_modules") {
      meta.targetModules = std::stoul(value);
    } else if (key == "global_step") {
      meta.globalStep = std::stoll(value);
    } else if (key == "current_step") {
      meta.currentStep = std::stoll(value);
    }
  }

  return true;
}

bool savePauseCheckpoint(
    ggml_opt_context_t optCtx, TrainingCheckpointState& state) {
  if (state.adapter == nullptr || state.ctx == nullptr ||
      state.model == nullptr) {
    return false;
  }

  // Use step-based naming: pause_checkpoint_step_{globalStep}
  const auto pauseDir =
      pauseCheckpointDirectory(state.checkpointDir, state.globalStep);
  std::error_code ec;
  std::filesystem::create_directories(pauseDir, ec);
  if (ec) {
    if (state.logFn) {
      std::ostringstream msg;
      msg << "Pause checkpoint save skipped | directory error: "
          << ec.message();
      state.logFn(msg.str());
    }
    return false;
  }

  const std::string pauseDirStr = pauseDir.string();
  if (!llama_lora_save_checkpoint(
          state.adapter, pauseDirStr.c_str(), state.model, state.ctx)) {
    if (state.logFn) {
      std::ostringstream msg;
      msg << "Failed to save LoRA pause checkpoint in " << pauseDirStr;
      state.logFn(msg.str());
    }
    return false;
  }

  const auto optimizerPath = pauseDir / "optimizer.gguf";
  if (!ggml_opt_save_state(optCtx, optimizerPath.string().c_str())) {
    if (state.logFn) {
      std::ostringstream msg;
      msg << "Unable to save optimizer state for pause checkpoint";
      state.logFn(msg.str());
    }
  }

  const auto metadataPath = pauseDir / "metadata.json";
  std::ofstream metadata(metadataPath);
  if (metadata.is_open()) {
    CheckpointMetadata meta{};
    meta.epoch = state.currentEpoch;
    meta.loraRank = state.loraRank;
    meta.loraAlpha = state.loraAlpha;
    meta.targetModules = state.targetModules;
    meta.globalStep = state.globalStep;
    meta.currentStep = state.scheduler ? state.scheduler->currentStep : 0;

    metadata << "epoch=" << meta.epoch << '\n';
    metadata << "lora_rank=" << meta.loraRank << '\n';
    metadata << std::fixed << std::setprecision(6);
    metadata << "lora_alpha=" << meta.loraAlpha << '\n';
    metadata << "target_modules=" << meta.targetModules << '\n';
    metadata << "global_step=" << meta.globalStep << '\n';
    metadata << "current_step=" << meta.currentStep << '\n';
  } else if (state.logFn) {
    std::ostringstream msg;
    msg << "Pause checkpoint metadata write failed";
    state.logFn(msg.str());
  }

  // Set pauseCheckpointPath so it's available for logging
  state.pauseCheckpointPath = pauseDir;

  if (state.logFn) {
    std::ostringstream msg;
    msg << "Pause checkpoint saved -> " << pauseDirStr;
    state.logFn(msg.str());
  }

  return true;
}

bool loadPauseCheckpoint(
    const std::filesystem::path& checkpointPath, llama_adapter_lora* adapter,
    llama_model* model, llama_context* ctx, ggml_opt_context_t* optCtx,
    CheckpointMetadata& meta) {
  if (!std::filesystem::exists(checkpointPath)) {
    return false;
  }

  // Load metadata to verify checkpoint is valid
  const auto metadataPath = checkpointPath / "metadata.json";
  if (!parseCheckpointMetadata(metadataPath, meta)) {
    return false;
  }

  // Note: Adapter state is loaded via llama_opt_init with checkpoint_path
  // The checkpoint directory is passed to llama_opt_init which loads both
  // optimizer state and adapter state from the checkpoint directory.
  // The adapter should be recreated with the same parameters before calling
  // llama_opt_init with the checkpoint path.

  return true;
}

bool pauseCheckpointExists(const std::filesystem::path& checkpointDir) {
  // Find the latest pause checkpoint (highest step number)
  const auto pausePath = findLatestPauseCheckpoint(checkpointDir);
  return !pausePath.empty() && std::filesystem::exists(pausePath) &&
         std::filesystem::is_directory(pausePath);
}

void clearPauseCheckpoint(const std::filesystem::path& checkpointDir) {
  // Find and clear the latest pause checkpoint
  const auto pausePath = findLatestPauseCheckpoint(checkpointDir);
  if (!pausePath.empty() && std::filesystem::exists(pausePath)) {
    std::error_code ec;
    std::filesystem::remove_all(pausePath, ec);
  }
}

void optEpochCallback(
    bool train, ggml_opt_context_t optCtx, ggml_opt_dataset_t dataset,
    ggml_opt_result_t result, int64_t ibatch, int64_t ibatchMax,
    int64_t tStartUs, TrainingCheckpointState* checkpointState) {
  ggml_opt_epoch_callback_progress_bar(
      train, optCtx, dataset, result, ibatch, ibatchMax, tStartUs);

  if (!train) {
    return;
  }

  auto* state = checkpointState;
  if (state == nullptr) {
    return;
  }

  // Handle mid-epoch resume: verify we're starting from the correct batch
  // NOTE: With the modified llama_opt_epoch that supports resume_from_batch
  // parameter, batches before the resume point are actually skipped (not
  // processed), so we should start processing from the correct batch. This
  // verification ensures the resume is working correctly.
  if (state->skippingBatches && state->batchOffsetWithinEpoch >= 0) {
    // We're resuming mid-epoch, verify we're starting from the correct batch
    if (ibatch == state->batchOffsetWithinEpoch) {
      // We've reached the resume point, stop skipping flag
      state->skippingBatches = false;
      if (state->logFn) {
        std::ostringstream resumeMsg;
        resumeMsg << "Resumed from batch " << (ibatch + 1) << "/" << ibatchMax
                  << " (globalStep will be " << (state->globalStep + 1) << ")";
        state->logFn(resumeMsg.str());
      }
    } else if (ibatch < state->batchOffsetWithinEpoch) {
      // This shouldn't happen if resume_from_batch is working correctly,
      // but log a warning if it does
      if (state->logFn) {
        std::ostringstream warnMsg;
        warnMsg << "Warning: Processing batch " << (ibatch + 1)
                << " but expected to resume from batch "
                << (state->batchOffsetWithinEpoch + 1);
        state->logFn(warnMsg.str());
      }
      // Don't update state for unexpected batches
      return;
    }
  }

  // Increment step counter (for both pause and periodic checkpoints)
  // Increment BEFORE checking pause so globalStep reflects the batch we just
  // processed
  state->globalStep += 1;

  // Verify first batch after resume matches expected batch
  if (state->expectedFirstBatchAfterResume >= 0 && state->logFn) {
    if (!state->firstBatchAfterResumeLogged) {
      if (state->globalStep == state->expectedFirstBatchAfterResume) {
        std::ostringstream verifyMsg;
        verifyMsg << "First batch after resume: " << state->globalStep
                  << " (expected: " << state->expectedFirstBatchAfterResume
                  << ")";
        state->logFn(verifyMsg.str());
        state->firstBatchAfterResumeLogged = true;
      }
    }
  }

  // Check for pause request
  if (state->pauseRequested.load()) {
    // Save pause checkpoint only once per pause request
    if (!state->pauseCheckpointSaved.load()) {
      // CRITICAL: Request immediate stop after current batch using new early
      // exit API This ensures training stops immediately after this batch, not
      // after entire epoch Call this before saving checkpoint to ensure clean
      // state
      if (state->ctx != nullptr) {
        llama_opt_request_stop(state->ctx);
      }

      // Save pause checkpoint
      if (savePauseCheckpoint(optCtx, *state)) {
        // Mark checkpoint as saved to prevent multiple saves
        state->pauseCheckpointSaved.store(true);

        // Signal training loop to exit
        // Note: We do NOT call llama_opt_cleanup() here because the callback
        // is called from within llama_opt_epoch(), which is still using the
        // optimizer context. Cleanup will be done after the training loop
        // exits.
        state->shouldExit.store(true);
        if (state->logFn) {
          std::ostringstream pauseMsg;
          pauseMsg << "Training paused at batch " << ibatch << "/" << ibatchMax
                   << " | epoch " << (state->currentEpoch + 1)
                   << " | Checkpoint saved at: "
                   << state->pauseCheckpointPath.string();
          state->logFn(pauseMsg.str());
        }
      } else {
        if (state->logFn) {
          state->logFn("Warning: Failed to save pause checkpoint");
        }
      }
    }
    return; // Exit callback - no further batches in this epoch will be
            // processed
  }

  // Regular periodic checkpointing
  if (state->checkpointInterval <= 0) {
    return;
  }

  if (state->globalStep % state->checkpointInterval != 0) {
    return;
  }

  saveCheckpoint(optCtx, *state);
}

// Wrapper function that uses global state (for compatibility with callback
// signature)
void optEpochCallbackWrapper(
    bool train, ggml_opt_context_t optCtx, ggml_opt_dataset_t dataset,
    ggml_opt_result_t result, int64_t ibatch, int64_t ibatchMax,
    int64_t tStartUs) {
  optEpochCallback(
      train,
      optCtx,
      dataset,
      result,
      ibatch,
      ibatchMax,
      tStartUs,
      gTrainingCheckpointState);
}

// Functions to manage global checkpoint state
void setGlobalCheckpointState(TrainingCheckpointState* state) {
  gTrainingCheckpointState = state;
}

TrainingCheckpointState* getGlobalCheckpointState() {
  return gTrainingCheckpointState;
}

void clearGlobalCheckpointState() { gTrainingCheckpointState = nullptr; }

#ifndef STANDALONE_TEST_BUILD
std::string resolveAdapterOutputPath(
    const qvac_lib_inference_addon_cpp::FinetuningParameters& params) {
  namespace fs = std::filesystem;
  if (!params.outputAdapterPath.empty()) {
    const fs::path explicitPath(params.outputAdapterPath);
    if (explicitPath.has_parent_path()) {
      fs::create_directories(explicitPath.parent_path());
    }
    return explicitPath.string();
  }

  fs::path base(params.outputParametersDir);
  if (base.empty()) {
    base = fs::path("finetuned-model");
  }

  if (base.has_extension() && base.extension() == ".gguf") {
    if (base.has_parent_path()) {
      fs::create_directories(base.parent_path());
    }
    return base.string();
  }

  fs::create_directories(base);
  return (base / "trained-lora-adapter.gguf").string();
}
#endif // STANDALONE_TEST_BUILD

} // namespace llama_finetuning_helpers

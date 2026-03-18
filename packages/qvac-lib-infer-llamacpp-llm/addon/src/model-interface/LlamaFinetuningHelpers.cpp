#include "LlamaFinetuningHelpers.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
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

#include "../utils/LoggingMacros.hpp"

namespace llama_finetuning_helpers {

using qvac_lib_inference_addon_cpp::logger::Priority;

static thread_local TrainingCheckpointState* tlsCurrentCheckpointState =
    nullptr;

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
    return latestPath;
  }

  for (const auto& entry : std::filesystem::directory_iterator(checkpointDir)) {
    if (!entry.is_directory()) {
      continue;
    }

    const std::string dirName = entry.path().filename().string();
    const std::string prefix = "pause_checkpoint_step_";

    if (dirName.size() > prefix.size() &&
        dirName.substr(0, prefix.size()) == prefix) {
      const std::string stepStr = dirName.substr(prefix.size());
      try {
        int64_t step = std::stoll(stepStr);
        if (step > latestStep) {
          latestStep = step;
          latestPath = entry.path();
        }
      } catch (const std::exception&) {
        continue;
      }
    }
  }

  return latestPath;
}

static void writeCheckpointMetadata(
    const std::filesystem::path& path, const CheckpointMetadata& meta) {
  std::ofstream out(path);
  if (!out) {
    throw std::runtime_error(
        "Failed to open checkpoint metadata: " + path.string());
  }
  out << "epoch=" << meta.epoch << '\n'
      << "lora_rank=" << meta.loraRank << '\n'
      << std::fixed << std::setprecision(6) << "lora_alpha=" << meta.loraAlpha
      << '\n'
      << "target_modules=" << meta.targetModules << '\n'
      << "global_step=" << meta.globalStep << '\n'
      << "current_step=" << meta.currentStep << '\n'
      << "resume_epoch=" << meta.resumeEpoch << '\n'
      << "resume_batch=" << meta.resumeBatch << '\n'
      << "paused_during_validation=" << (meta.pausedDuringValidation ? 1 : 0)
      << '\n';
  if (!out) {
    throw std::runtime_error(
        "Failed to write checkpoint metadata: " + path.string());
  }
}

void saveCheckpoint(ggml_opt_context_t optCtx, TrainingCheckpointState& state) {
  if (state.checkpointInterval <= 0 || state.adapter == nullptr ||
      state.ctx == nullptr || state.model == nullptr) {
    return;
  }

  const int64_t step = state.globalStep;
  const auto stepDir = checkpointStepDirectory(state, step);
  std::error_code ec;
  std::filesystem::create_directories(stepDir, ec);
  if (ec) {
    throw std::runtime_error(
        "Checkpoint directory creation failed at step " + std::to_string(step) +
        ": " + ec.message());
  }

  const std::string stepDirStr = stepDir.string();
  if (!llama_lora_save_checkpoint(
          state.adapter, stepDirStr.c_str(), state.model, state.ctx)) {
    throw std::runtime_error(
        "Failed to save LoRA checkpoint at step " + std::to_string(step) +
        " in " + stepDirStr);
  }

  const auto optimizerPath = stepDir / "optimizer.gguf";
  if (!ggml_opt_save_state(optCtx, optimizerPath.string().c_str())) {
    throw std::runtime_error(
        "Failed to save optimizer state at step " + std::to_string(step) +
        " in " + optimizerPath.string());
  }

  CheckpointMetadata meta{};
  meta.epoch = state.currentEpoch;
  meta.loraRank = state.loraRank;
  meta.loraAlpha = state.loraAlpha;
  meta.targetModules = state.targetModules;
  meta.globalStep = state.globalStep;
  meta.currentStep = state.scheduler ? state.scheduler->currentStep : 0;
  writeCheckpointMetadata(stepDir / "metadata.txt", meta);
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
    } else if (key == "resume_epoch") {
      meta.resumeEpoch = std::stoi(value);
    } else if (key == "resume_batch") {
      meta.resumeBatch = std::stoll(value);
    } else if (key == "paused_during_validation") {
      meta.pausedDuringValidation = (value == "1" || value == "true");
    }
  }

  return true;
}

void savePauseCheckpoint(
    ggml_opt_context_t optCtx, TrainingCheckpointState& state,
    bool pausedDuringValidation, int64_t ibatch) {
  if (state.adapter == nullptr || state.ctx == nullptr ||
      state.model == nullptr) {
    throw std::runtime_error(
        "Cannot save pause checkpoint: adapter, context or model is null");
  }

  const auto pauseDir =
      pauseCheckpointDirectory(state.checkpointDir, state.globalStep);
  std::error_code ec;
  std::filesystem::create_directories(pauseDir, ec);
  if (ec) {
    throw std::runtime_error(
        "Pause checkpoint directory creation failed: " + ec.message());
  }

  const std::string pauseDirStr = pauseDir.string();
  if (!llama_lora_save_checkpoint(
          state.adapter, pauseDirStr.c_str(), state.model, state.ctx)) {
    throw std::runtime_error(
        "Failed to save LoRA pause checkpoint in " + pauseDirStr);
  }

  const auto optimizerPath = pauseDir / "optimizer.gguf";
  if (!ggml_opt_save_state(optCtx, optimizerPath.string().c_str())) {
    throw std::runtime_error(
        "Failed to save optimizer state for pause checkpoint in " +
        optimizerPath.string());
  }

  CheckpointMetadata meta{};
  meta.epoch =
      pausedDuringValidation ? state.currentEpoch + 1 : state.currentEpoch;
  meta.loraRank = state.loraRank;
  meta.loraAlpha = state.loraAlpha;
  meta.targetModules = state.targetModules;
  meta.globalStep =
      pausedDuringValidation ? state.globalStep + 1 : state.globalStep;
  meta.currentStep = state.scheduler ? state.scheduler->currentStep : 0;
  meta.pausedDuringValidation = pausedDuringValidation;
  meta.resumeEpoch =
      pausedDuringValidation ? (state.currentEpoch + 1) : state.currentEpoch;
  if (pausedDuringValidation) {
    meta.resumeBatch = -1;
  } else {
    const int64_t nCtx = static_cast<int64_t>(llama_n_ctx(state.ctx));
    const int64_t nUbatch = std::max<int64_t>(
        int64_t{1}, static_cast<int64_t>(llama_n_ubatch(state.ctx)));
    const int64_t ubatchPerCtx = std::max<int64_t>(int64_t{1}, nCtx / nUbatch);
    // Store the idata index *before* the one being processed when pause fired,
    // so that opt_epoch's `idata = resume_from_batch + 1` restarts from the
    // same sample whose callback triggered the pause.
    meta.resumeBatch = (ibatch - 1) / ubatchPerCtx - 1;
  }
  writeCheckpointMetadata(pauseDir / "metadata.txt", meta);

  state.pauseCheckpointPath = pauseDir;
  std::ostringstream msg;
  msg << "Pause checkpoint saved -> " << pauseDirStr;
  QLOG_IF(Priority::DEBUG, msg.str());
}

bool tryHandlePauseRequest(
    ggml_opt_context_t optCtx, TrainingCheckpointState* state, bool train,
    int64_t ibatch, int64_t ibatchMax) {
  if (state == nullptr || !state->pauseRequested.load()) {
    return false;
  }
  if (state->pauseCheckpointSaved.load()) {
    return true;
  }
  if (state->ctx != nullptr) {
    llama_opt_request_stop(state->ctx);
  }
  const bool pausedDuringValidation = !train;
  savePauseCheckpoint(optCtx, *state, pausedDuringValidation, ibatch);
  state->pauseCheckpointSaved.store(true);
  state->shouldExit.store(true);
  state->isFinetuning.store(false);
  state->isPaused.store(true);
  std::ostringstream pauseMsg;
  pauseMsg << "Training paused";
  if (pausedDuringValidation) {
    pauseMsg << " during validation";
  }
  pauseMsg << " at batch " << ibatch << "/" << ibatchMax << " | epoch "
           << (state->currentEpoch + 1)
           << " | Checkpoint saved at: " << state->pauseCheckpointPath.string();
  QLOG_IF(Priority::DEBUG, pauseMsg.str());
  return true;
}

bool loadPauseCheckpoint(
    const std::filesystem::path& checkpointPath, llama_adapter_lora* adapter,
    llama_model* model, llama_context* ctx, ggml_opt_context_t* optCtx,
    CheckpointMetadata& meta) {
  if (!std::filesystem::exists(checkpointPath)) {
    return false;
  }

  const auto metadataPath = checkpointPath / "metadata.txt";
  if (!parseCheckpointMetadata(metadataPath, meta)) {
    return false;
  }

  return true;
}

bool pauseCheckpointExists(const std::filesystem::path& checkpointDir) {
  const auto pausePath = findLatestPauseCheckpoint(checkpointDir);
  return !pausePath.empty() && std::filesystem::exists(pausePath) &&
         std::filesystem::is_directory(pausePath);
}

void clearPauseCheckpoint(const std::filesystem::path& checkpointDir) {
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
  const bool isFinalBatch = (ibatch == ibatchMax);
  const int64_t displayBatch = ibatch;
  const bool isReplayBatch = train && checkpointState != nullptr &&
                             checkpointState->resumeGlobalStepSkip > 0;

  bool suppress =
      checkpointState != nullptr && checkpointState->suppressProgressBar;
  if (!suppress && !isReplayBatch) {
    ggml_opt_epoch_callback_progress_bar(
        train, optCtx, dataset, result, displayBatch, ibatchMax, tStartUs);
    std::fflush(stdout);
  }

  if (checkpointState != nullptr &&
      tryHandlePauseRequest(
          optCtx, checkpointState, train, ibatch, ibatchMax)) {
    return;
  }

  auto* state = checkpointState;
  if (state == nullptr) {
    return;
  }

  if (train) {
    bool pauseCheckpointAlreadySaved = state->pauseCheckpointSaved.load();
    bool shouldExitAlreadySet = state->shouldExit.load();
    if (pauseCheckpointAlreadySaved && shouldExitAlreadySet) {
      return;
    }
    if (state->resumeGlobalStepSkip > 0) {
      state->resumeGlobalStepSkip--;
    } else {
      state->globalStep += 1;
    }
  }

  if (state->progressCallback && !isReplayBatch) {
    double loss = 0.0;
    double lossUnc = 0.0;
    double accuracy = 0.0;
    double accUnc = 0.0;
    ggml_opt_result_loss(result, &loss, &lossUnc);
    ggml_opt_result_accuracy(result, &accuracy, &accUnc);

    const int64_t elapsedUs = ggml_time_us() - tStartUs;
    int64_t etaUs = 0;
    if (ibatch > 0) {
      etaUs = elapsedUs * (ibatchMax - ibatch) / ibatch;
    }

    FinetuneProgressStats progress;
    progress.isTrain = train;
    progress.loss = loss;
    progress.lossUncertainty = lossUnc;
    progress.accuracy = accuracy;
    progress.accuracyUncertainty = accUnc;
    progress.globalSteps = state->globalStep;
    progress.currentEpoch = state->currentEpoch;
    progress.currentBatch = displayBatch;
    progress.totalBatches = ibatchMax;
    progress.elapsedMs = elapsedUs / 1000;
    progress.etaMs = etaUs / 1000;
    state->progressCallback(progress);
  }

  if (!train) {
    return;
  }

  if (!state->finetuningStartedEmitted) {
    state->finetuningStartedEmitted = true;
    state->isIdle.store(false);
    state->isFinetuning.store(true);
    state->isPaused.store(false);
    QLOG_IF(Priority::INFO, "Finetuning started");
  }

  if (state->expectedFirstBatchAfterResume >= 0) {
    if (!state->firstBatchAfterResumeLogged) {
      if (state->globalStep == state->expectedFirstBatchAfterResume) {
        std::ostringstream verifyMsg;
        verifyMsg << "First batch after resume: " << state->globalStep
                  << " (expected: " << state->expectedFirstBatchAfterResume
                  << ")";
        QLOG_IF(Priority::DEBUG, verifyMsg.str());
        state->firstBatchAfterResumeLogged = true;
      }
    }
  }

  if (tryHandlePauseRequest(optCtx, state, true, ibatch, ibatchMax)) {
    return;
  }

  if (state->checkpointInterval <= 0) {
    return;
  }

  if (state->globalStep % state->checkpointInterval != 0) {
    return;
  }

  saveCheckpoint(optCtx, *state);
}

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
      tlsCurrentCheckpointState);
}

void setCurrentCheckpointState(TrainingCheckpointState* state) {
  tlsCurrentCheckpointState = state;
}

void clearCurrentCheckpointState() { tlsCurrentCheckpointState = nullptr; }

#ifndef STANDALONE_TEST_BUILD
std::string resolveAdapterOutputPath(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  namespace fs = std::filesystem;
  fs::path base(params.outputParametersDir);
  if (base.empty()) {
    base = fs::path("finetuned-model");
  }

  if (base.has_extension() && base.extension() == ".gguf") {
    if (base.has_parent_path()) {
      std::error_code ec;
      fs::create_directories(base.parent_path(), ec);
      if (ec) {
        throw std::runtime_error(
            "Failed to create adapter output directory: " + ec.message());
      }
    }
    return base.string();
  }

  std::error_code ec;
  fs::create_directories(base, ec);
  if (ec) {
    throw std::runtime_error(
        "Failed to create adapter output directory: " + ec.message());
  }
  return (base / "trained-lora-adapter.gguf").string();
}
#endif // STANDALONE_TEST_BUILD

} // namespace llama_finetuning_helpers

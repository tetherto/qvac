#include "LlamaFinetuner.hpp"

#ifndef STANDALONE_TEST_BUILD

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <memory>
#include <mutex>
#include <numeric>
#include <shared_mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <type_traits>

#include <common/common.h>
#include <ggml-backend.h>
#include <ggml-opt.h>
#include <ggml.h>
#include <llama.h>

#include "LlamaModel.hpp"
#include "utils/BackendSelection.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

static bool gpuSupportsOutProdF16() {
  ggml_backend_dev_t gpu =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
  if (gpu == nullptr) {
    return true;
  }

  constexpr int64_t ne0 = 4;
  constexpr int64_t ne1 = 3;
  constexpr int64_t k = 2;

  struct ggml_tensor src0 = {};
  struct ggml_tensor src1 = {};
  struct ggml_tensor dst = {};

  src0.type = GGML_TYPE_F16;
  src1.type = GGML_TYPE_F32;
  dst.type = GGML_TYPE_F32;

  src0.ne[0] = ne0;
  src0.ne[1] = k;
  src0.ne[2] = 1;
  src0.ne[3] = 1;
  src1.ne[0] = ne1;
  src1.ne[1] = k;
  src1.ne[2] = 1;
  src1.ne[3] = 1;
  dst.ne[0] = ne0;
  dst.ne[1] = ne1;
  dst.ne[2] = 1;
  dst.ne[3] = 1;

  src0.nb[0] = sizeof(ggml_fp16_t);
  src0.nb[1] = src0.nb[0] * ne0;
  src0.nb[2] = src0.nb[1] * k;
  src0.nb[3] = src0.nb[2];

  src1.nb[0] = sizeof(float);
  src1.nb[1] = src1.nb[0] * ne1;
  src1.nb[2] = src1.nb[1] * k;
  src1.nb[3] = src1.nb[2];

  dst.nb[0] = sizeof(float);
  dst.nb[1] = dst.nb[0] * ne0;
  dst.nb[2] = dst.nb[1] * ne1;
  dst.nb[3] = dst.nb[2];

  dst.op = GGML_OP_OUT_PROD;
  dst.src[0] = &src0;
  dst.src[1] = &src1;

  if (ggml_backend_dev_type(gpu) == GGML_BACKEND_DEVICE_TYPE_GPU &&
      !ggml_backend_dev_supports_op(gpu, &dst)) {
    return false;
  }
  return true;
}

std::string LlamaFinetuner::finetune(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    FinetuneTerminalResult::Stats* outStats,
    LlamaFinetuner::ProgressCallback progressCallback) {
  using namespace llama_finetuning_helpers;

  validateModelForFinetuning();

  {
    std::shared_lock lock(model_.stateMtx_);
    if (model_.state_->cacheManager_.has_value() &&
        model_.state_->cacheManager_->hasActiveCache()) {
      model_.state_->cacheManager_->saveCache();
    }
  }

  // Always reload: ensures tuneConfigMap applies finetuning-specific config
  // (e.g. flash-attn off, ubatch sizing) and gives a clean llama_context.
  // TODO: investigate recreating the context without a full weights reload
  // to reduce latency when the backend itself does not change.
  model_.reload(
      FinetuneConfigOverrides{
          .active = true,
          .batchSize = params.batchSize,
          .microBatchSize = params.microBatchSize,
          .contextLength = params.contextLength,
          .gpuSupportsF16OutProd = gpuSupportsOutProdF16(),
          .flashAttn = params.flashAttn});

  llama_context* ctx = model_.getContext();
  llama_model* mdl = model_.getModel();
  if (ctx == nullptr || mdl == nullptr) {
    throw std::runtime_error(
        "Finetune error: model/context not available after reload.");
  }

  try {

    validateFinetuningParams(params);

    std::filesystem::path checkpointDir =
        params.checkpointSaveDir.empty()
            ? std::filesystem::path{"./checkpoints"}
            : std::filesystem::path{params.checkpointSaveDir};
    bool allowResumeFromPause = pauseCheckpointExists(checkpointDir);
    if (allowResumeFromPause) {
      clearPauseRequest();
    }

    auto dataset = prepareTrainingDataset(params);
    std::unique_ptr<
        std::remove_pointer_t<ggml_opt_dataset_t>,
        decltype(&ggml_opt_dataset_free)>
        datasetPtr(dataset, ggml_opt_dataset_free);

    const int64_t datasetSampleCount = ggml_opt_dataset_ndata(datasetPtr.get());
    if (datasetSampleCount <= 0) {
      throw std::runtime_error(
          "Unable to build training dataset from provided corpus");
    }

    const int64_t ctxSize = llama_n_ctx(ctx);
    const int64_t sequenceLength =
        params.contextLength > 0
            ? std::clamp<int64_t>(params.contextLength, int64_t{8}, ctxSize)
            : std::max<int64_t>(ctxSize, 8);
    const int64_t microBatchSize =
        params.microBatchSize > 0 ? params.microBatchSize : 1;

    const int64_t requestedMicroBatch =
        microBatchSize > 0 ? microBatchSize : int64_t{1};
    int64_t actualMicroBatch =
        std::min<int64_t>(requestedMicroBatch, datasetSampleCount);
    actualMicroBatch = std::max<int64_t>(
        int64_t{1}, std::gcd(datasetSampleCount, actualMicroBatch));

    double validationSplit = 0.05;
    const bool hasSeparateEvalDataset =
        !params.evalDatasetPath.empty() &&
        params.evalDatasetPath != params.trainDatasetDir;
    if (params.useEvalDatasetForValidation && hasSeparateEvalDataset) {
      validationSplit = 0.0;
    } else {
      validationSplit = std::clamp(params.validationSplit, 0.0, 1.0);
    }

    int64_t trainSplit = datasetSampleCount;
    int64_t evalSplit = 0;
    if (validationSplit > 0.0 && datasetSampleCount > 1) {
      const double rawTrain =
          static_cast<double>(datasetSampleCount) * (1.0 - validationSplit);
      trainSplit = static_cast<int64_t>(std::floor(rawTrain));
      trainSplit =
          std::clamp<int64_t>(trainSplit, int64_t{1}, datasetSampleCount);
      evalSplit = datasetSampleCount - trainSplit;
    }

    std::ostringstream datasetInfo;
    datasetInfo << "Finetune dataset prepared | mode="
                << (params.assistantLossOnly ? "sft" : "causal")
                << " | sequenceLength=" << sequenceLength
                << " | samples=" << datasetSampleCount
                << " | trainSplit=" << trainSplit
                << " | evalSplit=" << evalSplit
                << " | microBatch=" << actualMicroBatch;
    QLOG_IF(Priority::DEBUG, datasetInfo.str());

    if (actualMicroBatch != requestedMicroBatch) {
      std::ostringstream microBatchMsg;
      microBatchMsg << "Requested microBatch=" << requestedMicroBatch
                    << " but using " << actualMicroBatch
                    << " due to dataset size";
      QLOG_IF(Priority::WARNING, microBatchMsg.str());
    }

    const int64_t ubatchPerSample = std::max<int64_t>(
        int64_t{1},
        static_cast<int64_t>(llama_n_ctx(ctx)) /
            static_cast<int64_t>(llama_n_ubatch(ctx)));
    const int64_t stepsPerEpoch =
        std::max<int64_t>(int64_t{1}, trainSplit * ubatchPerSample);
    // The LR scheduler advances once per optimizer step (once per sample),
    // not once per micro-batch callback, so use trainSplit directly.
    const int64_t schedulerTotalSteps = std::max<int64_t>(
        int64_t{1}, static_cast<int64_t>(params.numberOfEpochs) * trainSplit);

    auto schedulerState = createLrScheduler(params, schedulerTotalSteps);

    CheckpointMetadata resumeMeta{};
    bool resumingFromPause = false;
    std::filesystem::path pausePath;
    uint32_t resumeStartEpoch = 0;
    int64_t resumeBatchCursor = -1;

    if (allowResumeFromPause) {
      pausePath =
          llama_finetuning_helpers::findLatestPauseCheckpoint(checkpointDir);

      if (!pausePath.empty() && pauseCheckpointExists(checkpointDir)) {
        const auto metadataPath = pausePath / "metadata.txt";
        if (parseCheckpointMetadata(metadataPath, resumeMeta)) {
          resumingFromPause = true;
          std::ostringstream resumeMsg;
          resumeMsg << "Resuming training from checkpoint: "
                    << pausePath.string() << " | epoch "
                    << (resumeMeta.epoch + 1) << " | expected next batch: "
                    << (resumeMeta.globalStep + 1);
          QLOG_IF(Priority::DEBUG, resumeMsg.str());
        } else {
          QLOG_IF(
              Priority::WARNING,
              "Failed to parse checkpoint metadata, starting fresh");
        }
      }
    }

    llama_adapter_lora* adapter = nullptr;
    if (resumingFromPause) {
      const auto adapterPath = (pausePath / "model.gguf").string();
      adapter = llama_adapter_lora_init(mdl, adapterPath.c_str());
      if (adapter == nullptr) {
        throw std::runtime_error(
            "Failed to load LoRA adapter from checkpoint: " + adapterPath);
      }
      std::array<llama_adapter_lora*, 1> adapters{adapter};
      std::array<float, 1> adapterScales{1.0F};
      // llama_set_adapters_lora replaces the active adapter list, so no
      // separate clear is needed in 78db8bf4 (no llama_clear_adapter_lora).
      if (llama_set_adapters_lora(
              ctx, adapters.data(), adapters.size(), adapterScales.data()) <
          0) {
        throw std::runtime_error(
            "Failed to attach resumed LoRA adapter to context");
      }
    } else {
      uint32_t targetModules = parseLoraModules(params.loraModules);
      initializeLoraAdapter(params, targetModules, adapter);
    }

    clearPausedCheckpointStateShared();
    clearCurrentCheckpointStateShared();

    auto checkpointState =
        initializeCheckpointing(params, adapter, &schedulerState);

    if (checkpointState) {
      if (resumingFromPause) {
        checkpointState->globalStep = resumeMeta.globalStep;
        checkpointState->currentEpoch = resumeMeta.epoch;
        if (checkpointState->scheduler) {
          checkpointState->scheduler->currentStep = resumeMeta.currentStep;
        }
        checkpointState->expectedFirstBatchAfterResume =
            resumeMeta.globalStep + 1;
        checkpointState->firstBatchAfterResumeLogged = false;
        if (resumeMeta.resumeEpoch >= 0) {
          resumeStartEpoch = static_cast<uint32_t>(resumeMeta.resumeEpoch);
          resumeBatchCursor = resumeMeta.resumeBatch;
        } else {
          resumeStartEpoch = static_cast<uint32_t>(resumeMeta.epoch);
          resumeBatchCursor = -1;
        }
        checkpointState->batchOffsetWithinEpoch = resumeBatchCursor;

        const int64_t epochStartStep =
            static_cast<int64_t>(resumeStartEpoch) * stepsPerEpoch;
        const int64_t ibatchAtPause = resumeMeta.globalStep - epochStartStep;
        const int64_t firstIbatchOnResume =
            (resumeBatchCursor >= 0) ? (resumeBatchCursor + 1) * ubatchPerSample
                                     : 0;
        checkpointState->resumeGlobalStepSkip =
            std::max(int64_t{0}, ibatchAtPause - firstIbatchOnResume);

        std::ostringstream batchOffsetMsg;
        batchOffsetMsg << "Resuming from epoch " << (resumeStartEpoch + 1)
                       << " | idata batch cursor=" << resumeBatchCursor
                       << " | globalStep skip="
                       << checkpointState->resumeGlobalStepSkip;
        QLOG_IF(Priority::DEBUG, batchOffsetMsg.str());

        if (checkpointState->resumeGlobalStepSkip > 0) {
          std::ostringstream skipMsg;
          skipMsg << "Replaying " << checkpointState->resumeGlobalStepSkip
                  << " pre-pause micro-batches";
          QLOG_IF(Priority::INFO, skipMsg.str());
        }
      }
    }

    configureOptimizer(
        params,
        adapter,
        schedulerState,
        checkpointState.get(),
        resumingFromPause);

    if (resumingFromPause) {
      QLOG_IF(Priority::DEBUG, "Checkpoint loaded successfully");
    }

    if (checkpointState) {
      checkpointState->pauseWaitDone.store(false);
      checkpointState->progressCallback = progressCallback;
      if (progressCallback) {
        checkpointState->suppressProgressBar = true;
      }
      setCurrentCheckpointStateShared(checkpointState);
      setCurrentCheckpointState(checkpointState.get());
    }

    int64_t evalDatasetSampleCount = 0;
    std::unique_ptr<
        std::remove_pointer_t<ggml_opt_dataset_t>,
        decltype(&ggml_opt_dataset_free)>
        evalDatasetPtr(nullptr, ggml_opt_dataset_free);
    if (params.useEvalDatasetForValidation && hasSeparateEvalDataset) {
      evalDatasetPtr.reset(prepareEvalDataset(params));
      evalDatasetSampleCount = ggml_opt_dataset_ndata(evalDatasetPtr.get());
      if (evalDatasetSampleCount <= 0) {
        throw std::runtime_error("Eval dataset has no samples");
      }
      std::ostringstream evalMsg;
      evalMsg << "Eval dataset loaded | samples=" << evalDatasetSampleCount;
      QLOG_IF(Priority::DEBUG, evalMsg.str());
    }

    try {
      executeTrainingLoop(
          params,
          datasetPtr.get(),
          trainSplit,
          evalSplit,
          schedulerState,
          checkpointState.get(),
          resumingFromPause ? resumeStartEpoch : 0,
          resumingFromPause,
          evalDatasetPtr.get(),
          evalDatasetSampleCount,
          outStats);
    } catch (...) {
      if (checkpointState) {
        checkpointState->pauseWaitDone.store(true);
        checkpointState->pauseDoneCv.notify_all();
      }
      throw;
    }

    bool wasPaused = checkpointState && checkpointState->shouldExit.load() &&
                     checkpointState->pauseCheckpointSaved.load();

    if (checkpointState) {
      checkpointState->isIdle.store(true);
      checkpointState->isFinetuning.store(false);
      if (!wasPaused) {
        checkpointState->isPaused.store(false);
      }
      checkpointState->pauseWaitDone.store(true);
      checkpointState->pauseDoneCv.notify_all();
      clearCurrentCheckpointState();
      if (wasPaused) {
        setPausedCheckpointStateShared(checkpointState);
      } else {
        clearPausedCheckpointStateShared();
      }
      clearCurrentCheckpointStateShared();
    }

    if (!wasPaused) {
      saveLoraAdapter(adapter, params);

      const auto adapterPath =
          llama_finetuning_helpers::resolveAdapterOutputPath(params);
      QLOG_IF(Priority::DEBUG, "LoRA adapter saved to: " + adapterPath);
      QLOG_IF(Priority::DEBUG, "Finetune completed successfully");
    }

    const std::string status = wasPaused ? "PAUSED" : "COMPLETED";
    model_.reload(FinetuneConfigOverrides{});
    return status;
  } catch (...) {
    auto state = getCurrentCheckpointStateShared();
    if (state) {
      state->setIdle();
      state->pauseWaitDone.store(true);
      state->pauseDoneCv.notify_all();
    }
    auto pausedState = getPausedCheckpointStateShared();
    if (pausedState) {
      pausedState->setIdle();
    }
    llama_finetuning_helpers::clearCurrentCheckpointState();
    clearCurrentCheckpointStateShared();
    try {
      model_.reload(FinetuneConfigOverrides{});
    } catch (...) {
      QLOG_IF(Priority::ERROR, "Failed to reload model after finetuning error");
    }
    throw;
  }
}

void LlamaFinetuner::validateModelForFinetuning() {
  auto fileType = model_.metadata_.tryGetU32("general.file_type");
  if (fileType.has_value()) {
    const uint32_t ft = *fileType;
    constexpr std::array<llama_ftype, 6> kSupportedQuants = {
        LLAMA_FTYPE_ALL_F32,
        LLAMA_FTYPE_MOSTLY_F16,
        LLAMA_FTYPE_MOSTLY_Q4_0,
        LLAMA_FTYPE_MOSTLY_Q8_0,
        LLAMA_FTYPE_MOSTLY_TQ1_0,
        LLAMA_FTYPE_MOSTLY_TQ2_0};
    const bool supportedQuant =
        std::ranges::any_of(kSupportedQuants, [ft](auto q) { return q == ft; });
    if (!supportedQuant) {
      throw std::runtime_error(
          "Finetuning is not supported for this quantization type "
          "(file_type=" +
          std::to_string(ft) +
          "). Supported: F32, F16, Q4_0, Q8_0, TQ1_0, TQ2_0");
    }
  }

  if (auto unsupported = backend_selection::getUnknownFinetuneArchitecture(
          &model_.metadata_)) {
    throw std::runtime_error(
        "Finetuning is not supported for architecture: " + unsupported.value());
  }
}

void LlamaFinetuner::validateFinetuningParams(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  using namespace llama_finetuning_helpers;

  const uint32_t targetModules = parseLoraModules(params.loraModules);
  if (targetModules == 0) {
    throw std::runtime_error("No valid LoRA target modules selected");
  }

  if (params.loraRank <= 0) {
    throw std::runtime_error("LoRA rank must be greater than zero");
  }

  if (params.loraAlpha <= 0.0) {
    throw std::runtime_error("LoRA alpha must be greater than zero");
  }

  if (params.loraInitStd < 0.0) {
    throw std::runtime_error("LoRA init_std must be non-negative");
  }

  if (params.learningRate <= 0.0) {
    throw std::runtime_error("Learning rate must be positive");
  }

  if (params.weightDecay < 0.0) {
    throw std::runtime_error("Weight decay must be non-negative");
  }

  if (params.lrMin < 0.0) {
    throw std::runtime_error("Minimum learning rate must be non-negative");
  }

  LoraLrScheduleType scheduleType;
  if (parseLrScheduler(params.lrScheduler, scheduleType)) {
    if (scheduleType != LoraLrScheduleType::Constant &&
        params.lrMin > params.learningRate) {
      throw std::runtime_error(
          "lrMin cannot exceed learningRate for " + params.lrScheduler +
          " scheduler");
    }
  }

  if (params.batchSize > 0 && params.microBatchSize > 0) {
    if (params.microBatchSize > params.batchSize) {
      throw std::runtime_error("microBatchSize must be <= batchSize");
    }
    if (params.batchSize % params.microBatchSize != 0) {
      throw std::runtime_error("batchSize must be divisible by microBatchSize");
    }
  }
}

ggml_opt_dataset_t LlamaFinetuner::prepareDatasetFromPath(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    const std::string& datasetPath, const char* errorLabel,
    const char* constructKind) {
  using namespace llama_finetuning_helpers;

  llama_context* ctx = model_.getContext();
  if (ctx == nullptr) {
    throw std::runtime_error("Context not available");
  }

  const int64_t ctxSize = llama_n_ctx(ctx);
  const int64_t sequenceLength =
      params.contextLength > 0
          ? std::clamp<int64_t>(params.contextLength, int64_t{8}, ctxSize)
          : std::max<int64_t>(ctxSize, 8);

  const int64_t datasetStride =
      std::max<int64_t>(sequenceLength / 2, int64_t{1});
  ggml_opt_dataset_t datasetRaw = nullptr;

  if (params.assistantLossOnly) {
    const std::string jsonContent = readTextFile(datasetPath);
    datasetRaw = common_opt_sft_dataset_init(
        ctx, jsonContent, datasetStride, params.chatTemplatePath);
  } else {
    auto tokens = tokenizeDataset(ctx, datasetPath);
    const int64_t availableTokens = static_cast<int64_t>(tokens.size());
    if (availableTokens <= sequenceLength) {
      throw std::runtime_error(
          std::string(errorLabel) + " dataset does not contain enough tokens "
                                    "for the selected context length");
    }
    const int64_t maxDatasetOffset = availableTokens - sequenceLength - 1;
    if (maxDatasetOffset < datasetStride) {
      throw std::runtime_error(
          std::string(errorLabel) +
          " dataset does not contain enough tokens for the selected stride");
    }
    datasetRaw = buildNextTokenDataset(tokens, sequenceLength, datasetStride);
  }

  if (datasetRaw == nullptr) {
    throw std::runtime_error(
        std::string("Unable to construct ") + constructKind + " dataset");
  }
  return datasetRaw;
}

ggml_opt_dataset_t LlamaFinetuner::prepareTrainingDataset(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  return prepareDatasetFromPath(
      params, params.trainDatasetDir, "Training", "finetuning");
}

ggml_opt_dataset_t LlamaFinetuner::prepareEvalDataset(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  return prepareDatasetFromPath(params, params.evalDatasetPath, "Eval", "eval");
}

void LlamaFinetuner::initializeLoraAdapter(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    uint32_t targetModules, llama_adapter_lora*& adapter) {
  llama_context* ctx = model_.getContext();
  llama_model* mdl = model_.getModel();
  if (ctx == nullptr || mdl == nullptr) {
    throw std::runtime_error("Model/context not available");
  }

  llama_lora_training_params loraParams{
      targetModules,
      params.loraRank,
      static_cast<float>(params.loraAlpha),
      0.0f,
      static_cast<float>(params.loraInitStd),
      params.loraSeed};

  adapter = llama_lora_training_init(ctx, mdl, &loraParams);
  if (adapter == nullptr) {
    std::string errorMsg =
        "LoRA training initialization failed. Parameters: "
        "targetModules=" +
        std::to_string(targetModules) +
        ", loraRank=" + std::to_string(params.loraRank) +
        ", loraAlpha=" + std::to_string(params.loraAlpha) +
        ", loraInitStd=" + std::to_string(params.loraInitStd);
    throw std::runtime_error(errorMsg);
  }
}

llama_finetuning_helpers::LoraLrSchedulerState
LlamaFinetuner::createLrScheduler(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    int64_t totalSteps) {
  using namespace llama_finetuning_helpers;

  LoraLrScheduleType scheduleType;
  if (!parseLrScheduler(params.lrScheduler, scheduleType)) {
    throw std::runtime_error(
        "Unknown learning-rate scheduler: " + params.lrScheduler);
  }

  LoraLrSchedulerState schedulerState{};
  schedulerState.schedule = scheduleType;
  schedulerState.lrInit = static_cast<float>(params.learningRate);
  schedulerState.lrMin = static_cast<float>(params.lrMin);
  schedulerState.weightDecay = static_cast<float>(params.weightDecay);
  schedulerState.totalSteps = totalSteps;

  if (params.warmupStepsSet) {
    schedulerState.warmupSteps =
        std::clamp<int64_t>(params.warmupSteps, 0, schedulerState.totalSteps);
  } else if (params.warmupRatioSet) {
    schedulerState.warmupSteps = static_cast<int64_t>(
        static_cast<double>(schedulerState.totalSteps) * params.warmupRatio);
    schedulerState.warmupSteps = std::clamp<int64_t>(
        schedulerState.warmupSteps, 0, schedulerState.totalSteps);
  }
  schedulerState.warmupRatio =
      schedulerState.totalSteps == 0
          ? 0.0f
          : static_cast<float>(schedulerState.warmupSteps) /
                static_cast<float>(schedulerState.totalSteps);
  schedulerState.currentStep = 0;
  schedulerState.lastLr =
      schedulerLrForStep(schedulerState, schedulerState.currentStep);

  return schedulerState;
}

std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
LlamaFinetuner::initializeCheckpointing(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    llama_adapter_lora* adapter,
    llama_finetuning_helpers::LoraLrSchedulerState* scheduler) {
  using namespace llama_finetuning_helpers;

  bool periodicCheckpointingEnabled = params.checkpointSaveSteps > 0;

  llama_context* ctx = model_.getContext();
  llama_model* mdl = model_.getModel();
  if (ctx == nullptr || mdl == nullptr) {
    return nullptr;
  }

  auto checkpointState = std::make_shared<TrainingCheckpointState>();
  checkpointState->ctx = ctx;
  checkpointState->model = mdl;
  checkpointState->adapter = adapter;
  checkpointState->checkpointInterval =
      periodicCheckpointingEnabled
          ? std::max<int64_t>(
                int64_t{1}, static_cast<int64_t>(params.checkpointSaveSteps))
          : 0; // 0 means only pause/resume checkpoints, no periodic ones
  checkpointState->checkpointDir =
      params.checkpointSaveDir.empty()
          ? std::filesystem::path{"./checkpoints"}
          : std::filesystem::path{params.checkpointSaveDir};
  checkpointState->scheduler = scheduler;
  checkpointState->loraRank = params.loraRank;
  checkpointState->loraAlpha = static_cast<float>(params.loraAlpha);
  checkpointState->targetModules = parseLoraModules(params.loraModules);
  checkpointState->globalStep = 0;

  std::error_code dirErr;
  std::filesystem::create_directories(checkpointState->checkpointDir, dirErr);
  if (dirErr) {
    throw std::runtime_error(
        "Checkpoint directory creation failed: directory='" +
        checkpointState->checkpointDir.string() +
        "' error=" + dirErr.message());
  }

  if (periodicCheckpointingEnabled) {
    std::ostringstream msg;
    msg << "Checkpointing enabled | dir="
        << checkpointState->checkpointDir.string()
        << " | interval=" << checkpointState->checkpointInterval;
    QLOG_IF(Priority::DEBUG, msg.str());
  } else {
    std::ostringstream msg;
    msg << "Pause/resume checkpointing enabled | dir="
        << checkpointState->checkpointDir.string();
    QLOG_IF(Priority::DEBUG, msg.str());
  }

  return checkpointState;
}

void LlamaFinetuner::configureOptimizer(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    llama_adapter_lora* adapter,
    llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
    llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
    bool loadOptimizerState) {
  using namespace llama_finetuning_helpers;

  llama_context* ctx = model_.getContext();
  llama_model* mdl = model_.getModel();
  if (ctx == nullptr || mdl == nullptr) {
    throw std::runtime_error("Model/context not available");
  }

  llama_opt_params optParams = llama_opt_default_params();
  optParams.param_filter = llama_opt_param_filter_lora;
  optParams.get_opt_pars = schedulerOptimizerParams;
  optParams.get_opt_pars_ud = &scheduler;
  optParams.optimizer_type = GGML_OPT_OPTIMIZER_TYPE_ADAMW;

  std::string checkpointPathStr;
  if (loadOptimizerState && checkpointState) {
    const auto checkpointPath =
        llama_finetuning_helpers::findLatestPauseCheckpoint(
            checkpointState->checkpointDir);
    if (!checkpointPath.empty() && std::filesystem::exists(checkpointPath)) {
      const auto optimizerPath = checkpointPath / "optimizer.gguf";
      if (std::filesystem::exists(optimizerPath) &&
          std::filesystem::is_regular_file(optimizerPath)) {
        checkpointPathStr = optimizerPath.string();
        optParams.checkpoint_path = checkpointPathStr.c_str();
        optParams.load_optimizer_state = true;
        QLOG_IF(
            Priority::DEBUG,
            "Optimizer checkpoint found: " + optimizerPath.string());
      } else {
        QLOG_IF(
            Priority::WARNING,
            "Optimizer checkpoint missing: " + optimizerPath.string());
        optParams.checkpoint_path = nullptr;
        optParams.load_optimizer_state = false;
      }
    } else {
      optParams.checkpoint_path = nullptr;
      optParams.load_optimizer_state = false;
    }
  } else {
    optParams.checkpoint_path = nullptr;
    optParams.load_optimizer_state = false;
  }

  optParams.assistant_loss_only = params.assistantLossOnly;

  {
    std::ostringstream optimizerMsg;
    optimizerMsg << "Optimizer config | n_ctx_train=" << optParams.n_ctx_train
                 << " | model_ctx=" << llama_n_ctx(ctx)
                 << " | assistant_loss_only="
                 << (optParams.assistant_loss_only ? "true" : "false");
    QLOG_IF(Priority::DEBUG, optimizerMsg.str());
  }

  llama_opt_cleanup(ctx);

  llama_opt_init(ctx, mdl, optParams);
}

void LlamaFinetuner::executeTrainingLoop(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    ggml_opt_dataset_t dataset, int64_t trainSplit, int64_t evalSplit,
    llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
    llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
    uint32_t startEpoch, bool resumingFromPause, ggml_opt_dataset_t evalDataset,
    int64_t evalDatasetSampleCount, FinetuneTerminalResult::Stats* outStats) {
  using namespace llama_finetuning_helpers;
  using OptResultPtr = std::unique_ptr<
      std::remove_pointer_t<ggml_opt_result_t>,
      decltype(&ggml_opt_result_free)>;

  llama_context* ctx = model_.getContext();
  if (ctx == nullptr) {
    throw std::runtime_error("Context not available");
  }

  OptResultPtr trainResult(ggml_opt_result_init(), ggml_opt_result_free);
  OptResultPtr evalResult(nullptr, ggml_opt_result_free);
  const bool hasEval =
      evalSplit > 0 || (evalDataset != nullptr && evalDatasetSampleCount > 0);
  if (hasEval) {
    evalResult.reset(ggml_opt_result_init());
  }

  const int64_t idataSplit = trainSplit;
  const bool checkpointEnabled = checkpointState != nullptr;
  const auto callbackTrain = checkpointEnabled
                                 ? optEpochCallbackWrapper
                                 : ggml_opt_epoch_callback_progress_bar;

  double lastTrainLoss = 0.0;
  double lastTrainLossUnc = 0.0;
  double lastValLoss = 0.0;
  double lastValLossUnc = 0.0;
  double lastTrainAccuracy = 0.0;
  double lastTrainAccuracyUnc = 0.0;
  double lastValAccuracy = 0.0;
  double lastValAccuracyUnc = 0.0;
  int32_t completedEpochs = static_cast<int32_t>(startEpoch);

  for (uint32_t epoch = startEpoch; epoch < params.numberOfEpochs; ++epoch) {
    if (checkpointState && checkpointState->shouldExit.load()) {
      QLOG_IF(Priority::DEBUG, "Training paused");
      break;
    }

    std::ostringstream startMsg;
    startMsg << "Starting finetune epoch " << (epoch + 1) << "/"
             << params.numberOfEpochs;
    QLOG_IF(Priority::DEBUG, startMsg.str());

    if (checkpointEnabled) {
      checkpointState->currentEpoch = static_cast<int32_t>(epoch);
    }

    int64_t resumeFromBatch = -1;
    if (resumingFromPause && checkpointState && epoch == startEpoch) {
      resumeFromBatch = checkpointState->batchOffsetWithinEpoch;
    }

    llama_opt_epoch_resume(
        ctx,
        dataset,
        trainResult.get(),
        evalResult.get(),
        idataSplit,
        callbackTrain,
        evalSplit > 0 ? callbackTrain : nullptr,
        resumeFromBatch);

    if (evalDataset != nullptr && evalDatasetSampleCount > 0 &&
        (!checkpointState || !checkpointState->shouldExit.load())) {
      llama_opt_epoch(
          ctx,
          evalDataset,
          trainResult.get(),
          evalResult.get(),
          0,
          nullptr,
          callbackTrain);
    }

    if (!checkpointState || !checkpointState->shouldExit.load()) {
      const bool usingJsProgress =
          checkpointState && checkpointState->suppressProgressBar;
      if (!usingJsProgress) {
        if (checkpointEnabled) {
          std::cout << "\r";
          std::cout.flush();
        }
        std::cout << std::endl;
        std::cout.flush();
      }
    }

    ggml_opt_result_loss(trainResult.get(), &lastTrainLoss, &lastTrainLossUnc);
    ggml_opt_result_accuracy(
        trainResult.get(), &lastTrainAccuracy, &lastTrainAccuracyUnc);

    if (checkpointState && checkpointState->shouldExit.load()) {
      break;
    }

    if (hasEval) {
      ggml_opt_result_loss(evalResult.get(), &lastValLoss, &lastValLossUnc);
      ggml_opt_result_accuracy(
          evalResult.get(), &lastValAccuracy, &lastValAccuracyUnc);
    }

    completedEpochs = static_cast<int32_t>(epoch + 1);
    std::ostringstream epochMsg;
    epochMsg << "Epoch " << (epoch + 1)
             << " completed | loss=" << lastTrainLoss;
    if (hasEval) {
      epochMsg << " | val_loss=" << lastValLoss;
    }
    epochMsg << " | lr=" << scheduler.lastLr;
    QLOG_IF(Priority::DEBUG, epochMsg.str());
    ggml_opt_result_reset(trainResult.get());
    if (hasEval) {
      ggml_opt_result_reset(evalResult.get());
    }
  }

  if (outStats) {
    outStats->trainLoss = lastTrainLoss;
    outStats->trainLossUncertainty = lastTrainLossUnc;
    outStats->valLoss = lastValLoss;
    outStats->valLossUncertainty = lastValLossUnc;
    outStats->trainAccuracy = lastTrainAccuracy;
    outStats->trainAccuracyUncertainty = lastTrainAccuracyUnc;
    outStats->valAccuracy = lastValAccuracy;
    outStats->valAccuracyUncertainty = lastValAccuracyUnc;
    outStats->learningRate = static_cast<double>(scheduler.lastLr);
    outStats->epochsCompleted = completedEpochs;
    outStats->globalSteps = checkpointState ? checkpointState->globalStep : 0;
  }

  if (checkpointState && checkpointState->shouldExit.load() &&
      checkpointState->pauseCheckpointSaved.load()) {
    llama_opt_cleanup(ctx);
  }

  if (checkpointState && !checkpointState->shouldExit.load()) {
    clearPauseCheckpoint(checkpointState->checkpointDir);
  }

  if (outStats != nullptr && startEpoch >= params.numberOfEpochs &&
      checkpointState != nullptr && checkpointState->globalStep > 0) {
    outStats->globalSteps = checkpointState->globalStep;
    outStats->epochsCompleted = static_cast<int32_t>(params.numberOfEpochs);
  }
}

void LlamaFinetuner::saveLoraAdapter(
    llama_adapter_lora* adapter,
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  using namespace llama_finetuning_helpers;

  llama_model* mdl = model_.getModel();
  if (mdl == nullptr) {
    throw std::runtime_error("Model not available");
  }

  const auto adapterPath = resolveAdapterOutputPath(params);
  if (!llama_lora_save_adapter(adapter, adapterPath.c_str(), mdl)) {
    throw std::runtime_error("Unable to save LoRA adapter to " + adapterPath);
  }
}

std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
LlamaFinetuner::getCurrentCheckpointStateShared() const {
  std::scoped_lock lock(checkpointStateMutex_);
  return currentCheckpointState_;
}

void LlamaFinetuner::setCurrentCheckpointStateShared(
    std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState> state) {
  std::scoped_lock lock(checkpointStateMutex_);
  currentCheckpointState_ = std::move(state);
}

void LlamaFinetuner::clearCurrentCheckpointStateShared() {
  std::scoped_lock lock(checkpointStateMutex_);
  currentCheckpointState_.reset();
}

std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
LlamaFinetuner::getPausedCheckpointStateShared() const {
  std::scoped_lock lock(checkpointStateMutex_);
  return pausedCheckpointState_;
}

void LlamaFinetuner::setPausedCheckpointStateShared(
    std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState> state) {
  std::scoped_lock lock(checkpointStateMutex_);
  pausedCheckpointState_ = std::move(state);
}

void LlamaFinetuner::clearPausedCheckpointStateShared() {
  std::scoped_lock lock(checkpointStateMutex_);
  pausedCheckpointState_.reset();
}

bool LlamaFinetuner::isFinetuneRunning() const {
  auto state = getCurrentCheckpointStateShared();
  return state != nullptr &&
         state->isFinetuning.load(std::memory_order_acquire);
}

bool LlamaFinetuner::requestPause() {
  auto state = getCurrentCheckpointStateShared();
  if (state == nullptr) {
    return false;
  }
  state->pauseRequested.store(true);
  return true;
}

void LlamaFinetuner::waitUntilFinetuningPauseComplete() {
  auto state = getCurrentCheckpointStateShared();
  if (state == nullptr) {
    return;
  }

  constexpr auto timeout = std::chrono::minutes(5);
  std::unique_lock lock(state->pauseDoneMutex);
  state->pauseDoneCv.wait_for(lock, timeout, [&state] {
    return state->pauseWaitDone.load(std::memory_order_acquire) &&
           state->isIdle.load(std::memory_order_acquire);
  });
}

void LlamaFinetuner::clearPauseRequest() {
  clearPausedCheckpointStateShared();
  clearCurrentCheckpointStateShared();

  llama_context* ctx = model_.getContext();
  if (ctx != nullptr) {
    llama_opt_reset_stop(ctx);
  }
}

#endif // STANDALONE_TEST_BUILD

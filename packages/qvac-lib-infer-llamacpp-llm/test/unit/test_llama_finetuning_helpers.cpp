#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/LlamaFinetuningHelpers.hpp"

namespace fs = std::filesystem;

namespace {

TEST(LlamaFinetuningHelpers, ParseLoraModules_EmptyReturnsDefault) {
  uint32_t result = llama_finetuning_helpers::parseLoraModules("");
  EXPECT_EQ(
      result,
      (LLAMA_LORA_TARGET_ATTN_Q | LLAMA_LORA_TARGET_ATTN_K |
       LLAMA_LORA_TARGET_ATTN_V | LLAMA_LORA_TARGET_ATTN_O));
}

TEST(LlamaFinetuningHelpers, ParseLoraModules_SingleModule) {
  uint32_t result = llama_finetuning_helpers::parseLoraModules("attn_q");
  EXPECT_EQ(result, LLAMA_LORA_TARGET_ATTN_Q);
}

TEST(LlamaFinetuningHelpers, ParseLoraModules_MultipleModules) {
  uint32_t result =
      llama_finetuning_helpers::parseLoraModules("attn_q,attn_k,attn_v");
  EXPECT_EQ(
      result,
      (LLAMA_LORA_TARGET_ATTN_Q | LLAMA_LORA_TARGET_ATTN_K |
       LLAMA_LORA_TARGET_ATTN_V));
}

TEST(LlamaFinetuningHelpers, ParseLoraModules_WithWhitespace) {
  uint32_t result =
      llama_finetuning_helpers::parseLoraModules(" attn_q , attn_k ");
  EXPECT_EQ(result, (LLAMA_LORA_TARGET_ATTN_Q | LLAMA_LORA_TARGET_ATTN_K));
}

TEST(LlamaFinetuningHelpers, ParseLoraModules_All) {
  uint32_t result = llama_finetuning_helpers::parseLoraModules("all");
  EXPECT_EQ(result, LLAMA_LORA_TARGET_ALL);
}

TEST(LlamaFinetuningHelpers, ParseLrScheduler_Constant) {
  llama_finetuning_helpers::LoraLrScheduleType scheduleType;
  EXPECT_TRUE(
      llama_finetuning_helpers::parseLrScheduler("constant", scheduleType));
  EXPECT_EQ(
      scheduleType, llama_finetuning_helpers::LoraLrScheduleType::Constant);
}

TEST(LlamaFinetuningHelpers, ParseLrScheduler_Cosine) {
  llama_finetuning_helpers::LoraLrScheduleType scheduleType;
  EXPECT_TRUE(
      llama_finetuning_helpers::parseLrScheduler("cosine", scheduleType));
  EXPECT_EQ(scheduleType, llama_finetuning_helpers::LoraLrScheduleType::Cosine);
}

TEST(LlamaFinetuningHelpers, ParseLrScheduler_Linear) {
  llama_finetuning_helpers::LoraLrScheduleType scheduleType;
  EXPECT_TRUE(
      llama_finetuning_helpers::parseLrScheduler("linear", scheduleType));
  EXPECT_EQ(scheduleType, llama_finetuning_helpers::LoraLrScheduleType::Linear);
}

TEST(LlamaFinetuningHelpers, ParseLrScheduler_CaseInsensitive) {
  llama_finetuning_helpers::LoraLrScheduleType scheduleType;
  EXPECT_TRUE(
      llama_finetuning_helpers::parseLrScheduler("CONSTANT", scheduleType));
  EXPECT_EQ(
      scheduleType, llama_finetuning_helpers::LoraLrScheduleType::Constant);
}

TEST(LlamaFinetuningHelpers, ParseLrScheduler_InvalidReturnsFalse) {
  llama_finetuning_helpers::LoraLrScheduleType scheduleType;
  EXPECT_FALSE(
      llama_finetuning_helpers::parseLrScheduler("invalid", scheduleType));
}

TEST(LlamaFinetuningHelpers, SchedulerLrForStep_Constant) {
  llama_finetuning_helpers::LoraLrSchedulerState state;
  state.lrInit = 1e-4f;
  state.lrMin = 1e-6f;
  state.totalSteps = 100;
  state.warmupSteps = 10;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Constant;

  float lr = llama_finetuning_helpers::schedulerLrForStep(state, 50);
  EXPECT_NEAR(lr, state.lrInit, 1e-6f);
}

TEST(LlamaFinetuningHelpers, SchedulerLrForStep_WarmupPhase) {
  llama_finetuning_helpers::LoraLrSchedulerState state;
  state.lrInit = 1e-4f;
  state.lrMin = 1e-6f;
  state.totalSteps = 100;
  state.warmupSteps = 10;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Constant;

  float lr = llama_finetuning_helpers::schedulerLrForStep(state, 5);
  EXPECT_GT(lr, 0.0f);
  EXPECT_LT(lr, state.lrInit);
}

TEST(LlamaFinetuningHelpers, SchedulerLrForStep_CosineInRange) {
  llama_finetuning_helpers::LoraLrSchedulerState state;
  state.lrInit = 1e-4f;
  state.lrMin = 1e-6f;
  state.totalSteps = 100;
  state.warmupSteps = 0;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Cosine;

  float lr = llama_finetuning_helpers::schedulerLrForStep(state, 50);
  EXPECT_GE(lr, state.lrMin);
  EXPECT_LE(lr, state.lrInit);
}

TEST(LlamaFinetuningHelpers, SchedulerLrForStep_LinearInRange) {
  llama_finetuning_helpers::LoraLrSchedulerState state;
  state.lrInit = 1e-4f;
  state.lrMin = 1e-6f;
  state.totalSteps = 100;
  state.warmupSteps = 0;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Linear;

  float lr = llama_finetuning_helpers::schedulerLrForStep(state, 50);
  EXPECT_GE(lr, state.lrMin);
  EXPECT_LE(lr, state.lrInit);
}

TEST(LlamaFinetuningHelpers, CheckpointStepDirectory) {
  llama_finetuning_helpers::TrainingCheckpointState state;
  state.checkpointDir = fs::path("/tmp/checkpoints");

  fs::path result =
      llama_finetuning_helpers::checkpointStepDirectory(state, 42);
  EXPECT_EQ(result.filename().string(), "checkpoint_step_00000042");
  EXPECT_EQ(result.parent_path(), state.checkpointDir);
}

TEST(LlamaFinetuningHelpers, PauseCheckpointDirectory) {
  fs::path checkpointDir = "/tmp/checkpoints";

  fs::path result =
      llama_finetuning_helpers::pauseCheckpointDirectory(checkpointDir, 123);
  EXPECT_EQ(result.filename().string(), "pause_checkpoint_step_00000123");
  EXPECT_EQ(result.parent_path(), checkpointDir);
}

static std::string uniqueTestId() {
  return std::to_string(
      std::chrono::high_resolution_clock::now().time_since_epoch().count());
}

TEST(LlamaFinetuningHelpers, FindLatestPauseCheckpoint_EmptyDir) {
  fs::path tmpDir =
      fs::temp_directory_path() / ("finetune_test_empty_" + uniqueTestId());
  fs::create_directories(tmpDir);

  fs::path result = llama_finetuning_helpers::findLatestPauseCheckpoint(tmpDir);
  EXPECT_TRUE(result.empty());

  fs::remove_all(tmpDir);
}

TEST(LlamaFinetuningHelpers, FindLatestPauseCheckpoint_NonexistentDir) {
  fs::path nonexistent =
      fs::temp_directory_path() / ("nonexistent_" + uniqueTestId());
  fs::path result =
      llama_finetuning_helpers::findLatestPauseCheckpoint(nonexistent);
  EXPECT_TRUE(result.empty());
}

TEST(LlamaFinetuningHelpers, FindLatestPauseCheckpoint_ReturnsLatest) {
  fs::path tmpDir =
      fs::temp_directory_path() / ("finetune_test_find_" + uniqueTestId());
  fs::create_directories(tmpDir);

  fs::path step5 = tmpDir / "pause_checkpoint_step_00000005";
  fs::path step12 = tmpDir / "pause_checkpoint_step_00000012";
  fs::path step3 = tmpDir / "pause_checkpoint_step_00000003";
  fs::create_directories(step5);
  fs::create_directories(step12);
  fs::create_directories(step3);

  fs::path result = llama_finetuning_helpers::findLatestPauseCheckpoint(tmpDir);
  EXPECT_EQ(result, step12);

  fs::remove_all(tmpDir);
}

TEST(LlamaFinetuningHelpers, FindLatestPauseCheckpoint_IgnoresNonMatching) {
  fs::path tmpDir =
      fs::temp_directory_path() / ("finetune_test_ignore_" + uniqueTestId());
  fs::create_directories(tmpDir);

  fs::path stepDir = tmpDir / "pause_checkpoint_step_00000001";
  fs::path otherDir = tmpDir / "checkpoint_step_00000001";
  fs::path randomDir = tmpDir / "random_folder";
  fs::create_directories(stepDir);
  fs::create_directories(otherDir);
  fs::create_directories(randomDir);

  fs::path result = llama_finetuning_helpers::findLatestPauseCheckpoint(tmpDir);
  EXPECT_EQ(result, stepDir);

  fs::remove_all(tmpDir);
}

TEST(LlamaFinetuningHelpers, PauseCheckpointExists_WhenExists) {
  fs::path tmpDir =
      fs::temp_directory_path() / ("finetune_test_exists_" + uniqueTestId());
  fs::create_directories(tmpDir);
  fs::path stepDir = tmpDir / "pause_checkpoint_step_00000001";
  fs::create_directories(stepDir);

  bool result = llama_finetuning_helpers::pauseCheckpointExists(tmpDir);
  EXPECT_TRUE(result);

  fs::remove_all(tmpDir);
}

TEST(LlamaFinetuningHelpers, PauseCheckpointExists_WhenEmpty) {
  fs::path tmpDir =
      fs::temp_directory_path() / ("finetune_test_noexist_" + uniqueTestId());
  fs::create_directories(tmpDir);

  bool result = llama_finetuning_helpers::pauseCheckpointExists(tmpDir);
  EXPECT_FALSE(result);

  fs::remove_all(tmpDir);
}

// Regression: savePauseCheckpoint writes epoch = currentEpoch + 1 when paused
// during validation.  On resume with numberOfEpochs=1 the training loop is
// skipped entirely, so executeTrainingLoop must still populate terminal stats.
TEST(
    LlamaFinetuningHelpers,
    ParseCheckpointMetadata_PauseDuringValidationIncrementsEpoch) {
  fs::path tmpDir = fs::temp_directory_path() /
                    ("finetune_test_pause_meta_" + uniqueTestId());
  fs::create_directories(tmpDir);

  auto writeMeta = [&](const std::string& name, const std::string& content) {
    const fs::path p = tmpDir / name;
    std::ofstream out(p);
    out << content;
    return p;
  };

  // Validation-phase pause: epoch is incremented to currentEpoch + 1.
  {
    auto path = writeMeta(
        "val_pause.json",
        "epoch=1\nlora_rank=8\nlora_alpha=16.000000\n"
        "target_modules=15\nglobal_step=5\ncurrent_step=5\n");
    llama_finetuning_helpers::CheckpointMetadata meta{};
    ASSERT_TRUE(llama_finetuning_helpers::parseCheckpointMetadata(path, meta));
    EXPECT_EQ(meta.epoch, 1);
    EXPECT_EQ(meta.globalStep, 5);
  }

  // Training-phase pause: epoch stays at currentEpoch.
  {
    auto path = writeMeta(
        "train_pause.json",
        "epoch=0\nlora_rank=8\nlora_alpha=16.000000\n"
        "target_modules=15\nglobal_step=3\ncurrent_step=3\n");
    llama_finetuning_helpers::CheckpointMetadata meta{};
    ASSERT_TRUE(llama_finetuning_helpers::parseCheckpointMetadata(path, meta));
    EXPECT_EQ(meta.epoch, 0);
    EXPECT_EQ(meta.globalStep, 3);
  }

  fs::remove_all(tmpDir);
}

TEST(LlamaFinetuningHelpers, SetIdle_ClearsAllFinetuningFlags) {
  llama_finetuning_helpers::TrainingCheckpointState state;
  state.isIdle.store(false);
  state.isFinetuning.store(true);
  state.isPaused.store(true);

  state.setIdle();

  EXPECT_TRUE(state.isIdle.load());
  EXPECT_FALSE(state.isFinetuning.load());
  EXPECT_FALSE(state.isPaused.load());
}

TEST(LlamaFinetuningHelpers, ClearPauseCheckpoint_RemovesPauseButKeepsRegular) {
  fs::path tmpDir =
      fs::temp_directory_path() / ("finetune_test_clear_" + uniqueTestId());
  fs::create_directories(tmpDir);

  fs::path pauseDir = tmpDir / "pause_checkpoint_step_00000010";
  fs::path regularDir = tmpDir / "checkpoint_step_00000010";
  fs::create_directories(pauseDir);
  fs::create_directories(regularDir);

  llama_finetuning_helpers::clearPauseCheckpoint(tmpDir);

  EXPECT_FALSE(fs::exists(pauseDir));
  EXPECT_TRUE(fs::exists(regularDir));

  fs::remove_all(tmpDir);
}

TEST(LlamaFinetuningHelpers, ClearPauseCheckpoint_NoOpOnEmptyDir) {
  fs::path tmpDir = fs::temp_directory_path() /
                    ("finetune_test_clear_empty_" + uniqueTestId());
  fs::create_directories(tmpDir);

  EXPECT_NO_THROW(llama_finetuning_helpers::clearPauseCheckpoint(tmpDir));

  fs::remove_all(tmpDir);
}

TEST(
    LlamaFinetuningHelpers,
    ParseCheckpointMetadata_ResumeEpochAndBatchAndPausedFlag) {
  fs::path tmpDir = fs::temp_directory_path() /
                    ("finetune_test_resume_meta_" + uniqueTestId());
  fs::create_directories(tmpDir);

  const fs::path metaPath = tmpDir / "metadata.txt";
  {
    std::ofstream out(metaPath);
    out << "epoch=2\n"
        << "lora_rank=16\n"
        << "lora_alpha=32.000000\n"
        << "target_modules=15\n"
        << "global_step=50\n"
        << "current_step=50\n"
        << "resume_epoch=3\n"
        << "resume_batch=7\n"
        << "paused_during_validation=1\n";
  }

  llama_finetuning_helpers::CheckpointMetadata meta{};
  ASSERT_TRUE(
      llama_finetuning_helpers::parseCheckpointMetadata(metaPath, meta));
  EXPECT_EQ(meta.epoch, 2);
  EXPECT_EQ(meta.loraRank, 16);
  EXPECT_NEAR(meta.loraAlpha, 32.0f, 1e-3f);
  EXPECT_EQ(meta.targetModules, 15u);
  EXPECT_EQ(meta.globalStep, 50);
  EXPECT_EQ(meta.currentStep, 50);
  EXPECT_EQ(meta.resumeEpoch, 3);
  EXPECT_EQ(meta.resumeBatch, 7);
  EXPECT_TRUE(meta.pausedDuringValidation);

  fs::remove_all(tmpDir);
}

TEST(LlamaFinetuningHelpers, ParseCheckpointMetadata_DefaultsForMissingFields) {
  fs::path tmpDir = fs::temp_directory_path() /
                    ("finetune_test_defaults_meta_" + uniqueTestId());
  fs::create_directories(tmpDir);

  const fs::path metaPath = tmpDir / "metadata.txt";
  {
    std::ofstream out(metaPath);
    out << "epoch=1\n"
        << "global_step=10\n";
  }

  llama_finetuning_helpers::CheckpointMetadata meta{};
  ASSERT_TRUE(
      llama_finetuning_helpers::parseCheckpointMetadata(metaPath, meta));
  EXPECT_EQ(meta.epoch, 1);
  EXPECT_EQ(meta.globalStep, 10);
  EXPECT_EQ(meta.resumeEpoch, -1);
  EXPECT_EQ(meta.resumeBatch, -1);
  EXPECT_FALSE(meta.pausedDuringValidation);

  fs::remove_all(tmpDir);
}

TEST(LlamaFinetuningHelpers, ParseCheckpointMetadata_NonexistentReturnsFalse) {
  fs::path noFile =
      fs::temp_directory_path() / ("nonexistent_meta_" + uniqueTestId());
  llama_finetuning_helpers::CheckpointMetadata meta{};
  EXPECT_FALSE(llama_finetuning_helpers::parseCheckpointMetadata(noFile, meta));
}

TEST(LlamaFinetuningHelpers, SetAndClearCurrentCheckpointState) {
  llama_finetuning_helpers::TrainingCheckpointState state;
  state.globalStep = 42;

  llama_finetuning_helpers::setCurrentCheckpointState(&state);
  llama_finetuning_helpers::clearCurrentCheckpointState();
}

TEST(LlamaFinetuningHelpers, SchedulerOptimizerParams_AdvancesStepAndSetsLr) {
  llama_finetuning_helpers::LoraLrSchedulerState state{};
  state.lrInit = 1e-4f;
  state.lrMin = 0.0f;
  state.totalSteps = 100;
  state.currentStep = 0;
  state.weightDecay = 0.01f;
  state.warmupSteps = 0;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Constant;

  auto params = llama_finetuning_helpers::schedulerOptimizerParams(&state);

  EXPECT_EQ(state.currentStep, 1);
  EXPECT_NEAR(params.adamw.alpha, 1e-4f, 1e-7f);
  EXPECT_NEAR(params.adamw.wd, 0.01f, 1e-7f);
  EXPECT_NEAR(params.sgd.alpha, 1e-4f, 1e-7f);
  EXPECT_NEAR(params.sgd.wd, 0.01f, 1e-7f);
  EXPECT_NEAR(state.lastLr, 1e-4f, 1e-7f);

  llama_finetuning_helpers::schedulerOptimizerParams(&state);
  EXPECT_EQ(state.currentStep, 2);
}

TEST(
    LlamaFinetuningHelpers,
    SchedulerOptimizerParams_DoesNotAdvancePastTotalSteps) {
  llama_finetuning_helpers::LoraLrSchedulerState state{};
  state.lrInit = 1e-4f;
  state.totalSteps = 5;
  state.currentStep = 5;
  state.warmupSteps = 0;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Constant;

  llama_finetuning_helpers::schedulerOptimizerParams(&state);
  EXPECT_EQ(state.currentStep, 5);
}

TEST(LlamaFinetuningHelpers, SchedulerLrForStep_ZeroTotalStepsReturnsLrInit) {
  llama_finetuning_helpers::LoraLrSchedulerState state{};
  state.lrInit = 5e-5f;
  state.totalSteps = 0;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Cosine;

  float lr = llama_finetuning_helpers::schedulerLrForStep(state, 0);
  EXPECT_NEAR(lr, 5e-5f, 1e-7f);
}

TEST(LlamaFinetuningHelpers, SchedulerLrForStep_StepBeyondTotalIsClamped) {
  llama_finetuning_helpers::LoraLrSchedulerState state{};
  state.lrInit = 1e-4f;
  state.lrMin = 1e-6f;
  state.totalSteps = 100;
  state.warmupSteps = 0;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Linear;

  float lrAtEnd = llama_finetuning_helpers::schedulerLrForStep(state, 100);
  float lrBeyond = llama_finetuning_helpers::schedulerLrForStep(state, 200);
  EXPECT_NEAR(lrAtEnd, lrBeyond, 1e-7f);
  EXPECT_GE(lrBeyond, state.lrMin);
}

TEST(
    LlamaFinetuningHelpers,
    SchedulerLrForStep_WarmupBoundaryMatchesPostWarmup) {
  llama_finetuning_helpers::LoraLrSchedulerState state{};
  state.lrInit = 1e-4f;
  state.lrMin = 0.0f;
  state.totalSteps = 100;
  state.warmupSteps = 10;
  state.schedule = llama_finetuning_helpers::LoraLrScheduleType::Constant;

  float lrAtWarmupEnd = llama_finetuning_helpers::schedulerLrForStep(state, 10);
  float lrPostWarmup = llama_finetuning_helpers::schedulerLrForStep(state, 11);
  EXPECT_NEAR(lrAtWarmupEnd, state.lrInit, 1e-6f);
  EXPECT_NEAR(lrPostWarmup, state.lrInit, 1e-6f);
}

TEST(LlamaFinetuningHelpers, TryHandlePauseRequest_NullStateReturnsFalse) {
  EXPECT_FALSE(llama_finetuning_helpers::tryHandlePauseRequest(
      nullptr, nullptr, true, 1, 10));
}

TEST(
    LlamaFinetuningHelpers,
    TryHandlePauseRequest_NoPauseRequestedReturnsFalse) {
  llama_finetuning_helpers::TrainingCheckpointState state;
  state.pauseRequested.store(false);

  EXPECT_FALSE(llama_finetuning_helpers::tryHandlePauseRequest(
      nullptr, &state, true, 1, 10));
}

TEST(
    LlamaFinetuningHelpers,
    TryHandlePauseRequest_AlreadySavedReturnsTrueWithoutResaving) {
  llama_finetuning_helpers::TrainingCheckpointState state;
  state.pauseRequested.store(true);
  state.pauseCheckpointSaved.store(true);
  state.shouldExit.store(false);
  state.isFinetuning.store(true);
  state.isPaused.store(false);

  EXPECT_TRUE(llama_finetuning_helpers::tryHandlePauseRequest(
      nullptr, &state, true, 5, 10));

  EXPECT_FALSE(state.shouldExit.load());
  EXPECT_TRUE(state.isFinetuning.load());
  EXPECT_FALSE(state.isPaused.load());
}

TEST(LlamaFinetuningHelpers, LoadPauseCheckpoint_SucceedsWithValidMetadata) {
  fs::path tmpDir =
      fs::temp_directory_path() / ("finetune_test_load_ckpt_" + uniqueTestId());
  fs::create_directories(tmpDir);

  fs::path ckptDir = tmpDir / "pause_checkpoint_step_00000025";
  fs::create_directories(ckptDir);
  {
    std::ofstream out(ckptDir / "metadata.txt");
    out << "epoch=1\n"
        << "lora_rank=8\n"
        << "lora_alpha=16.000000\n"
        << "target_modules=15\n"
        << "global_step=25\n"
        << "current_step=25\n"
        << "resume_epoch=1\n"
        << "resume_batch=3\n"
        << "paused_during_validation=0\n";
  }

  llama_finetuning_helpers::CheckpointMetadata meta{};
  bool ok = llama_finetuning_helpers::loadPauseCheckpoint(
      ckptDir, nullptr, nullptr, nullptr, nullptr, meta);

  EXPECT_TRUE(ok);
  EXPECT_EQ(meta.epoch, 1);
  EXPECT_EQ(meta.globalStep, 25);
  EXPECT_EQ(meta.resumeEpoch, 1);
  EXPECT_EQ(meta.resumeBatch, 3);
  EXPECT_FALSE(meta.pausedDuringValidation);

  fs::remove_all(tmpDir);
}

TEST(
    LlamaFinetuningHelpers,
    LoadPauseCheckpoint_ReturnsFalseForNonexistentPath) {
  fs::path noDir =
      fs::temp_directory_path() / ("nonexistent_ckpt_" + uniqueTestId());
  llama_finetuning_helpers::CheckpointMetadata meta{};

  EXPECT_FALSE(llama_finetuning_helpers::loadPauseCheckpoint(
      noDir, nullptr, nullptr, nullptr, nullptr, meta));
}

TEST(
    LlamaFinetuningHelpers,
    LoadPauseCheckpoint_ReturnsFalseWhenMetadataFileMissing) {
  fs::path tmpDir =
      fs::temp_directory_path() / ("finetune_test_no_meta_" + uniqueTestId());
  fs::path ckptDir = tmpDir / "pause_checkpoint_step_00000001";
  fs::create_directories(ckptDir);

  llama_finetuning_helpers::CheckpointMetadata meta{};
  EXPECT_FALSE(llama_finetuning_helpers::loadPauseCheckpoint(
      ckptDir, nullptr, nullptr, nullptr, nullptr, meta));

  fs::remove_all(tmpDir);
}

TEST(
    LlamaFinetuningHelpers,
    ClearPauseCheckpoint_OnlyRemovesLatestWhenMultipleExist) {
  fs::path tmpDir = fs::temp_directory_path() /
                    ("finetune_test_clear_multi_" + uniqueTestId());
  fs::create_directories(tmpDir);

  fs::path older = tmpDir / "pause_checkpoint_step_00000005";
  fs::path latest = tmpDir / "pause_checkpoint_step_00000015";
  fs::create_directories(older);
  fs::create_directories(latest);

  llama_finetuning_helpers::clearPauseCheckpoint(tmpDir);

  EXPECT_TRUE(fs::exists(older));
  EXPECT_FALSE(fs::exists(latest));

  fs::remove_all(tmpDir);
}

} // namespace

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
TEST(LlamaFinetuningHelpers,
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
    auto path = writeMeta("val_pause.json",
        "epoch=1\nlora_rank=8\nlora_alpha=16.000000\n"
        "target_modules=15\nglobal_step=5\ncurrent_step=5\n");
    llama_finetuning_helpers::CheckpointMetadata meta{};
    ASSERT_TRUE(
        llama_finetuning_helpers::parseCheckpointMetadata(path, meta));
    EXPECT_EQ(meta.epoch, 1);
    EXPECT_EQ(meta.globalStep, 5);
  }

  // Training-phase pause: epoch stays at currentEpoch.
  {
    auto path = writeMeta("train_pause.json",
        "epoch=0\nlora_rank=8\nlora_alpha=16.000000\n"
        "target_modules=15\nglobal_step=3\ncurrent_step=3\n");
    llama_finetuning_helpers::CheckpointMetadata meta{};
    ASSERT_TRUE(
        llama_finetuning_helpers::parseCheckpointMetadata(path, meta));
    EXPECT_EQ(meta.epoch, 0);
    EXPECT_EQ(meta.globalStep, 3);
  }

  fs::remove_all(tmpDir);
}

} // namespace

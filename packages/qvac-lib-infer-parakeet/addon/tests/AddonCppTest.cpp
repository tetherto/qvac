#include <any>
#include <algorithm>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "addon/AddonCpp.hpp"

namespace {

auto makeConfig() -> qvac_lib_infer_parakeet::ParakeetConfig {
  qvac_lib_infer_parakeet::ParakeetConfig config;
  config.modelType = qvac_lib_infer_parakeet::ModelType::TDT;
  config.sampleRate = 16000;
  config.channels = 1;
  return config;
}

auto makeInputSamples(size_t seconds) -> std::vector<float> {
  static constexpr size_t kSampleRate = 16000;
  return std::vector<float>(kSampleRate * seconds, 0.0f);
}

auto hasStatKey(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) -> bool {
  return std::any_of(
      stats.begin(),
      stats.end(),
      [&](const auto& entry) { return entry.first == key; });
}

} // namespace

TEST(ParakeetAddonCppTest, RunJobEmitsOutputAndRuntimeStats) {
  auto instance = qvac_lib_infer_parakeet::createInstance(makeConfig());

  auto input = makeInputSamples(1);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(input))));

  auto maybeOutput = instance.transcriptOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(maybeOutput.has_value());
  ASSERT_FALSE(maybeOutput->empty());
  EXPECT_FALSE(maybeOutput->front().text.empty());

  auto maybeStats = instance.statsOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(maybeStats.has_value());
  EXPECT_TRUE(hasStatKey(*maybeStats, "totalTime"));
  EXPECT_TRUE(hasStatKey(*maybeStats, "audioDurationMs"));
  EXPECT_TRUE(hasStatKey(*maybeStats, "totalSamples"));
}

TEST(ParakeetAddonCppTest, RejectsSecondRunWhileBusy) {
  auto instance = qvac_lib_infer_parakeet::createInstance(makeConfig());

  auto firstInput = makeInputSamples(5);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(firstInput))));

  auto secondInput = makeInputSamples(1);
  EXPECT_FALSE(instance.addon->runJob(std::any(std::move(secondInput))));
}

TEST(ParakeetAddonCppTest, DISABLED_CancelAllowsNextRun) {
  auto instance = qvac_lib_infer_parakeet::createInstance(makeConfig());

  auto firstInput = makeInputSamples(5);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(firstInput))));
  instance.addon->cancelJob();

  auto maybeCancelError =
      instance.errorOutput->tryPop(std::chrono::seconds(5));

  if (!maybeCancelError.has_value()) {
    instance.transcriptOutput->tryPop(std::chrono::seconds(1));
    instance.statsOutput->tryPop(std::chrono::seconds(1));
  }

  auto secondInput = makeInputSamples(1);
  bool accepted = false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    if (instance.addon->runJob(std::any(secondInput))) {
      accepted = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  ASSERT_TRUE(accepted);

  auto maybeStats = instance.statsOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(maybeStats.has_value());
}

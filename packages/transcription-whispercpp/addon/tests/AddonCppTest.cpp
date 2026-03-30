#include "addon/AddonCpp.hpp"

#include <algorithm>
#include <any>
#include <chrono>
#include <filesystem>
#include <ranges>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

namespace {
constexpr int K_STATS_TIMEOUT_SECONDS = 30;
constexpr int K_CANCEL_TIMEOUT_SECONDS = 10;
constexpr int K_CANCEL_SETTLE_DELAY_MS = 10;
constexpr std::size_t K_SHORT_AUDIO_SECONDS = 1;
constexpr std::size_t K_LONG_AUDIO_SECONDS = 20;

auto makeConfig(bool useGpu = false)
    -> qvac_lib_inference_addon_whisper::WhisperConfig {
  qvac_lib_inference_addon_whisper::WhisperConfig config;
  config.whisperContextCfg["model"] =
      std::string("../../../examples/models/ggml-tiny.bin");
  config.whisperContextCfg["use_gpu"] = useGpu;
  config.whisperMainCfg["language"] = std::string("en");
  config.whisperMainCfg["temperature"] = 0.0F;
  config.miscConfig["caption_enabled"] = false;
  return config;
}

auto hasModelFile() -> bool {
  return std::filesystem::exists("../../../examples/models/ggml-tiny.bin");
}

auto makeInputSamples(size_t seconds) -> std::vector<float> {
  static constexpr size_t kSampleRate = 16000;
  // NOLINTNEXTLINE(modernize-return-braced-init-list)
  return std::vector<float>(kSampleRate * seconds, 0.0F);
}

auto hasStatKey(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) -> bool {
  return std::ranges::any_of(
      stats, [&](const auto& entry) { return entry.first == key; });
}

} // namespace

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TEST(WhisperAddonCppTest, RunJobEmitsRuntimeStats) {
  ASSERT_TRUE(hasModelFile())
      << "whisper model file is required for parity test";
  auto instance =
      qvac_lib_inference_addon_whisper::createInstance(makeConfig());
  instance.addon->activate();

  auto input = makeInputSamples(K_SHORT_AUDIO_SECONDS);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(input))));

  auto maybeStats = instance.statsOutput->tryPop(
      std::chrono::seconds(K_STATS_TIMEOUT_SECONDS));
  ASSERT_TRUE(maybeStats.has_value())
      << "runtime stats were not emitted within timeout";
  if (!maybeStats.has_value()) {
    FAIL() << "runtime stats were not emitted within timeout";
  }
  const auto& stats = *maybeStats;
  EXPECT_FALSE(stats.empty());
  EXPECT_TRUE(hasStatKey(stats, "totalTime"));
  EXPECT_TRUE(hasStatKey(stats, "audioDurationMs"));
  EXPECT_TRUE(hasStatKey(stats, "totalSamples"));
}

TEST(WhisperAddonCppTest, RunJobWithGpuEnabledConfigCompletes) {
  ASSERT_TRUE(hasModelFile())
      << "whisper model file is required for parity test";
  auto instance =
      qvac_lib_inference_addon_whisper::createInstance(makeConfig(true));
  instance.addon->activate();

  auto input = makeInputSamples(K_SHORT_AUDIO_SECONDS);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(input))));

  auto maybeStats = instance.statsOutput->tryPop(
      std::chrono::seconds(K_STATS_TIMEOUT_SECONDS));
  ASSERT_TRUE(maybeStats.has_value())
      << "runtime stats were not emitted for use_gpu=true";
  if (!maybeStats.has_value()) {
    FAIL() << "runtime stats were not emitted for use_gpu=true";
  }
  const auto& stats = *maybeStats;
  EXPECT_TRUE(hasStatKey(stats, "totalTime"));
}

TEST(WhisperAddonCppTest, RejectsSecondRunWhileBusy) {
  ASSERT_TRUE(hasModelFile())
      << "whisper model file is required for parity test";
  auto instance =
      qvac_lib_inference_addon_whisper::createInstance(makeConfig());
  instance.addon->activate();

  auto firstInput = makeInputSamples(K_LONG_AUDIO_SECONDS);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(firstInput))));

  auto secondInput = makeInputSamples(K_SHORT_AUDIO_SECONDS);
  EXPECT_FALSE(instance.addon->runJob(std::any(std::move(secondInput))));
}

TEST(WhisperAddonCppTest, CancelAllowsNextRun) {
  ASSERT_TRUE(hasModelFile())
      << "whisper model file is required for parity test";
  auto instance =
      qvac_lib_inference_addon_whisper::createInstance(makeConfig());
  instance.addon->activate();

  auto firstInput = makeInputSamples(K_LONG_AUDIO_SECONDS);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(firstInput))));

  std::this_thread::sleep_for(
      std::chrono::milliseconds(K_CANCEL_SETTLE_DELAY_MS));
  instance.addon->cancelJob();

  auto cancelledError = instance.errorOutput->tryPop(
      std::chrono::seconds(K_CANCEL_TIMEOUT_SECONDS));
  ASSERT_TRUE(cancelledError.has_value())
      << "cancel signal did not emit an error within timeout";

  auto secondInput = makeInputSamples(K_SHORT_AUDIO_SECONDS);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(secondInput))));
  auto maybeStats = instance.statsOutput->tryPop(
      std::chrono::seconds(K_STATS_TIMEOUT_SECONDS));
  ASSERT_TRUE(maybeStats.has_value())
      << "second run did not emit runtime stats within timeout";
  if (!maybeStats.has_value()) {
    FAIL() << "second run did not emit runtime stats within timeout";
  }
  const auto& stats = *maybeStats;
  EXPECT_TRUE(hasStatKey(stats, "totalTime"));
}

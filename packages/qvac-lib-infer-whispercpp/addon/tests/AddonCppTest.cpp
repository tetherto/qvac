#include "addon/AddonCpp.hpp"

#include <algorithm>
#include <any>
#include <chrono>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

namespace {

auto makeConfig(bool useGpu = false)
    -> qvac_lib_inference_addon_whisper::WhisperConfig {
  qvac_lib_inference_addon_whisper::WhisperConfig config;
  config.whisperContextCfg["model"] =
      std::string("../../../examples/models/ggml-tiny.bin");
  config.whisperContextCfg["use_gpu"] = useGpu;
  config.whisperMainCfg["language"] = std::string("en");
  config.whisperMainCfg["temperature"] = 0.0;
  config.miscConfig["caption_enabled"] = false;
  return config;
}

auto hasModelFile() -> bool {
  return std::filesystem::exists("../../../examples/models/ggml-tiny.bin");
}

auto makeInputSamples(size_t seconds) -> std::vector<float> {
  static constexpr size_t kSampleRate = 16000;
  return std::vector<float>(kSampleRate * seconds, 0.0f);
}

auto hasStatKey(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) -> bool {
  return std::any_of(stats.begin(), stats.end(), [&](const auto& entry) {
    return entry.first == key;
  });
}

} // namespace

TEST(WhisperAddonCppTest, RunJobEmitsRuntimeStats) {
  ASSERT_TRUE(hasModelFile())
      << "whisper model file is required for parity test";
  auto instance =
      qvac_lib_inference_addon_whisper::createInstance(makeConfig());
  instance.addon->activate();

  auto input = makeInputSamples(1);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(input))));

  auto maybeStats = instance.statsOutput->tryPop(std::chrono::seconds(30));
  ASSERT_TRUE(maybeStats.has_value())
      << "runtime stats were not emitted within timeout";
  EXPECT_FALSE(maybeStats->empty());
  EXPECT_TRUE(hasStatKey(*maybeStats, "totalTime"));
  EXPECT_TRUE(hasStatKey(*maybeStats, "audioDurationMs"));
  EXPECT_TRUE(hasStatKey(*maybeStats, "totalSamples"));
}

TEST(WhisperAddonCppTest, RunJobWithGpuEnabledConfigCompletes) {
  ASSERT_TRUE(hasModelFile())
      << "whisper model file is required for parity test";
  auto instance =
      qvac_lib_inference_addon_whisper::createInstance(makeConfig(true));
  instance.addon->activate();

  auto input = makeInputSamples(1);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(input))));

  auto maybeStats = instance.statsOutput->tryPop(std::chrono::seconds(30));
  ASSERT_TRUE(maybeStats.has_value())
      << "runtime stats were not emitted for use_gpu=true";
  EXPECT_TRUE(hasStatKey(*maybeStats, "totalTime"));
}

TEST(WhisperAddonCppTest, RejectsSecondRunWhileBusy) {
  ASSERT_TRUE(hasModelFile())
      << "whisper model file is required for parity test";
  auto instance =
      qvac_lib_inference_addon_whisper::createInstance(makeConfig());
  instance.addon->activate();

  auto firstInput = makeInputSamples(20);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(firstInput))));

  auto secondInput = makeInputSamples(1);
  EXPECT_FALSE(instance.addon->runJob(std::any(std::move(secondInput))));
}

TEST(WhisperAddonCppTest, CancelAllowsNextRun) {
  ASSERT_TRUE(hasModelFile())
      << "whisper model file is required for parity test";
  auto instance =
      qvac_lib_inference_addon_whisper::createInstance(makeConfig());
  instance.addon->activate();

  auto firstInput = makeInputSamples(20);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(firstInput))));

  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  instance.addon->cancelJob();

  auto cancelledError = instance.errorOutput->tryPop(std::chrono::seconds(10));
  ASSERT_TRUE(cancelledError.has_value())
      << "cancel signal did not emit an error within timeout";

  auto secondInput = makeInputSamples(1);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(secondInput))));
  auto stats = instance.statsOutput->tryPop(std::chrono::seconds(30));
  ASSERT_TRUE(stats.has_value())
      << "second run did not emit runtime stats within timeout";
  EXPECT_TRUE(hasStatKey(*stats, "totalTime"));
}

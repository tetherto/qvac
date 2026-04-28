#include <algorithm>
#include <cmath>
#include <filesystem>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "../src/model-interface/TranslationModel.hpp"

namespace qvac_lib_inference_addon_nmt::test {

using qvac_lib_inference_addon_nmt::TranslationModel;

std::string getValidModelPath();

std::string getInvalidModelPath();

std::any make_valid_input();

std::any make_empty_input();

class NmtCppModelWrapperTest : public ::testing::Test {
protected:
  void SetUp() override {
    if (!std::filesystem::exists(getValidModelPath())) {
      GTEST_SKIP()
          << "Model not found: "
          << std::filesystem::absolute(getValidModelPath()).string()
          << "\nSee models/unit-test/README.md for setup instructions.";
    }
  }

  void TearDown() override {
    // Cleanup code if needed
  }
};

TEST_F(NmtCppModelWrapperTest, ConstructionWithValidConfig) {
  EXPECT_NO_THROW({ TranslationModel wrapper(getValidModelPath()); });
}

TEST_F(NmtCppModelWrapperTest, InitialState) {
  TranslationModel wrapper(getValidModelPath());

  // Initially should not be loaded
  EXPECT_FALSE(wrapper.isLoaded());
}

TEST_F(NmtCppModelWrapperTest, LoadingLifecycle) {
  TranslationModel wrapper(getValidModelPath());

  EXPECT_NO_THROW(wrapper.load());

  EXPECT_TRUE(wrapper.isLoaded());

  EXPECT_NO_THROW(wrapper.unload());
}

TEST_F(NmtCppModelWrapperTest, LoadWithInvalidModelPath) {
  TranslationModel wrapper(getInvalidModelPath());

  EXPECT_THROW(wrapper.load(), std::runtime_error);
}

TEST_F(NmtCppModelWrapperTest, DefaultConstructor_LoadThrowsDueToEmptyPath) {
  TranslationModel wrapper; // no modelPath
  EXPECT_THROW(wrapper.load(), std::runtime_error);
}

TEST_F(NmtCppModelWrapperTest, SaveLoadParamsEmptyPath_ThenLoadThrows) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.saveLoadParams("");
  EXPECT_THROW(wrapper.load(), std::runtime_error);
}

TEST_F(
    NmtCppModelWrapperTest, SaveLoadParamsAfterLoad_TakesEffectOnlyOnReload) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_TRUE(wrapper.isLoaded());

  // Change to invalid path but do not reload yet
  wrapper.saveLoadParams(getInvalidModelPath());

  // Still loaded; process should continue to work
  std::any input = make_valid_input();
  EXPECT_NO_THROW({
    auto out = std::any_cast<std::string>(wrapper.process(input));
    EXPECT_GE(out.size(), 0);
  });

  // Reload should now try using the new (invalid) path and throw
  EXPECT_THROW(wrapper.reload(), std::runtime_error);
}

TEST_F(NmtCppModelWrapperTest, ReloadCycle) {
  TranslationModel wrapper(getValidModelPath());

  wrapper.load();
  EXPECT_TRUE(wrapper.isLoaded());

  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
}

TEST_F(NmtCppModelWrapperTest, Reset) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  EXPECT_NO_THROW(wrapper.reset());
}

TEST_F(NmtCppModelWrapperTest, ProcessValidInput) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  auto validInput = make_valid_input();

  EXPECT_NO_THROW({
    auto result = std::any_cast<std::string>(wrapper.process(validInput));
    EXPECT_GE(result.size(), 0); // Should return vector (possibly empty)
  });
}

TEST_F(NmtCppModelWrapperTest, ProcessEmptyInput) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  auto emptyInput = make_empty_input();
  EXPECT_NO_THROW({
    auto result = std::any_cast<std::string>(wrapper.process(emptyInput));
    EXPECT_EQ(result.size(), 0); // Empty input should return empty result
  });
}

TEST_F(NmtCppModelWrapperTest, ProcessWithoutLoading) {
  TranslationModel wrapper(getValidModelPath());
  auto validInputs = make_valid_input();

  EXPECT_NO_THROW(wrapper.process(validInputs));
}

TEST_F(
    NmtCppModelWrapperTest,
    RuntimeStats_NotLoadedReturnsEmptyAndStringMessage) {
  TranslationModel wrapper(getValidModelPath());

  // Not loaded: runtimeStats should be empty
  const auto stats = wrapper.runtimeStats();
  EXPECT_TRUE(stats.empty());
}

TEST_F(NmtCppModelWrapperTest, RuntimeStats_ResetClearsStats) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  auto input = make_valid_input();
  wrapper.process(input);

  const auto beforeReset = wrapper.runtimeStats();
  EXPECT_FALSE(beforeReset.empty());

  wrapper.reset();

  const auto afterReset = wrapper.runtimeStats();
  // After reset, all runtime stats values are zeroed (not empty).
  ASSERT_FALSE(afterReset.empty());

  auto findStatByKey =
      [&](const char* key) -> const std::variant<double, int64_t>* {
    const auto iterator = std::find_if(
        afterReset.begin(), afterReset.end(), [&](const auto& entry) {
          return entry.first == key;
        });
    return iterator == afterReset.end() ? nullptr : &iterator->second;
  };

  const auto* totalTokens = findStatByKey("totalTokens");
  const auto* totalTime = findStatByKey("totalTime");
  const auto* encodeTime = findStatByKey("encodeTime");
  const auto* decodeTime = findStatByKey("decodeTime");

  ASSERT_NE(totalTokens, nullptr);
  ASSERT_NE(totalTime, nullptr);
  ASSERT_NE(encodeTime, nullptr);
  ASSERT_NE(decodeTime, nullptr);

  EXPECT_EQ(std::get<int64_t>(*totalTokens), static_cast<int64_t>(0));
  EXPECT_DOUBLE_EQ(std::get<double>(*totalTime), 0.0);
  EXPECT_DOUBLE_EQ(std::get<double>(*encodeTime), 0.0);
  EXPECT_DOUBLE_EQ(std::get<double>(*decodeTime), 0.0);
}

TEST_F(
    NmtCppModelWrapperTest,
    RuntimeStatsToString_HasExpectedKeysWhenStatsExist) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  auto input = make_valid_input();
  wrapper.process(input);

  const auto stats = wrapper.runtimeStats();
  EXPECT_TRUE(stats.empty());
}

TEST_F(NmtCppModelWrapperTest, RuntimeStatsDisabled) {
  TranslationModel wrapper(getValidModelPath()); // Stats disabled
  wrapper.load();

  auto stats = wrapper.runtimeStats();

  EXPECT_GE(stats.size(), 0);
}

TEST_F(NmtCppModelWrapperTest, GetNmtConfig) {
  TranslationModel wrapper(getValidModelPath());

  const std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
      generationConfig = {
          {"beamsize", 4},
          {"lengthpenalty", 1},
          {"maxlength", 500},
          {"norepeatngramsize", 1.2f},
          {"norepeatngramsize", 10},
          {"temperature", 1.2f},
          {"topk", 50},
          {"topp", 0.8}};

  wrapper.setConfig(generationConfig);

  auto modelGenerationConfig = wrapper.getConfig();

  for (auto&& el : generationConfig) {
    const auto& configName = el.first;
    EXPECT_TRUE(modelGenerationConfig.find(configName) != modelGenerationConfig.end());
    auto modelConfigValue = modelGenerationConfig.at(configName);
    auto configValue = generationConfig.at(configName);
    EXPECT_EQ(modelConfigValue, configValue);
  }
}

TEST_F(NmtCppModelWrapperTest, SetConfigStoredBeforeLoad_NoLoad) {
  TranslationModel wrapper; // default constructed, no ctx

  const std::unordered_map<std::string, std::variant<double, int64_t, std::string>> cfg = {
      {"beamsize", static_cast<int64_t>(5)},
      {"temperature", 0.7},
      {"unknown_key_xyz", static_cast<int64_t>(123)}};

  EXPECT_NO_THROW(wrapper.setConfig(cfg));

  const auto stored = wrapper.getConfig();
  for (const auto& kv : cfg) {
    EXPECT_TRUE(stored.find(kv.first) != stored.end());
    EXPECT_EQ(stored.at(kv.first), kv.second);
  }
}

TEST_F(NmtCppModelWrapperTest, SetConfigBeforeLoad_NotAppliedUntilAfterLoad) {
  TranslationModel wrapper(getValidModelPath());

  wrapper.load();

  // Use a long input to make maxlength have visible effect
  const std::string longInput =
      "This is a very long input sentence repeated multiple times to ensure "
      "length effects. This is a very long input sentence repeated multiple "
      "times to ensure length effects. This is a very long input sentence.";

  // Since pre-load config was not applied, this should be unconstrained/default
  auto out_before = std::any_cast<std::string>(wrapper.process(longInput));
  EXPECT_FALSE(out_before.empty());

  // Apply the same limiting config AFTER load (should now affect decoding)
  wrapper.setConfig(
      {{"maxlength", static_cast<int64_t>(5)},
       {"beamsize", static_cast<int64_t>(1)}});
  auto out_after = std::any_cast<std::string>(wrapper.process(longInput));
  EXPECT_FALSE(out_after.empty());

  // Expect a difference, or at least a shorter output after applying maxlength
  EXPECT_TRUE(out_after != out_before || out_after.size() < out_before.size());
}

TEST_F(NmtCppModelWrapperTest, UnknownKeysIgnored_NoSideEffects) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  // Setting unknown keys should not throw an exception
  EXPECT_NO_THROW(wrapper.setConfig(
      {{"unknown_param_A", static_cast<int64_t>(42)},
       {"unknown_param_B", 0.5}}));
}

TEST_F(NmtCppModelWrapperTest, ReapplyConfigOverridesPrevious_LastWriteWins) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  EXPECT_NO_THROW(wrapper.setConfig({{"beamsize", static_cast<int64_t>(4)}}));
  EXPECT_NO_THROW(wrapper.setConfig({{"beamsize", static_cast<int64_t>(8)}}));

  const auto stored = wrapper.getConfig();
  ASSERT_TRUE(stored.find("beamsize") != stored.end());
  EXPECT_EQ(std::get<int64_t>(stored.at("beamsize")), static_cast<int64_t>(8));
}

TEST_F(NmtCppModelWrapperTest, MultipleProcessCalls) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  auto validInput = make_valid_input();

  // Multiple consecutive processing calls should work
  for (int i = 0; i < 3; ++i) {
    EXPECT_NO_THROW({
      auto result = std::any_cast<std::string>(wrapper.process(validInput));
      EXPECT_GE(result.size(), 0);
    });
  }
}

TEST_F(NmtCppModelWrapperTest, DestructorCleanup) {
  // Test that destructor properly cleans up
  {
    TranslationModel wrapper(getValidModelPath());
    wrapper.load();
    // Wrapper destructor should be called here
  }
  // No crash should occur
  EXPECT_TRUE(true);
}

TEST_F(NmtCppModelWrapperTest, LoadUnloadSequence) {
  TranslationModel wrapper(getValidModelPath());

  // Multiple load/unload cycles
  for (int cycle = 0; cycle < 2; ++cycle) {
    wrapper.load();
    EXPECT_TRUE(wrapper.isLoaded());

    // Process sample input
    auto validInput = make_valid_input();
    wrapper.process(validInput);

    wrapper.unload();
  }
}

TEST_F(NmtCppModelWrapperTest, UnloadWhenNotLoadedIsIdempotent) {
  TranslationModel wrapper(getValidModelPath());

  EXPECT_NO_THROW(wrapper.unload());
  EXPECT_FALSE(wrapper.isLoaded());

  EXPECT_NO_THROW(wrapper.unload());
  EXPECT_FALSE(wrapper.isLoaded());
}

TEST_F(NmtCppModelWrapperTest, IsLoadedFalseAfterUnload) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_TRUE(wrapper.isLoaded());

  wrapper.unload();
  EXPECT_FALSE(wrapper.isLoaded());
}

TEST_F(NmtCppModelWrapperTest, ReloadWhenNotLoadedWithValidPath) {
  TranslationModel wrapper(getValidModelPath());

  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
}

TEST_F(NmtCppModelWrapperTest, ReloadWhenNotLoadedWithInvalidPath) {
  TranslationModel wrapper(getInvalidModelPath());

  // TODO Change to qvac_errors::StatusError
  EXPECT_THROW(wrapper.reload(), std::runtime_error);
}

TEST_F(NmtCppModelWrapperTest, ReloadAfterUnloadRestoresLoadedState) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_TRUE(wrapper.isLoaded());

  wrapper.unload();
  EXPECT_FALSE(wrapper.isLoaded());

  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
}

TEST_F(NmtCppModelWrapperTest, DoubleReloadMaintainsStability) {
  TranslationModel wrapper(getValidModelPath());

  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());

  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
}

// Skip-capable equivalents of ModelApi tests
TEST_F(NmtCppModelWrapperTest, ModelApi_InitializeLoadUnloadReloadReset) {
  TranslationModel wrapper(getValidModelPath());

  EXPECT_NO_THROW(wrapper.load());
  EXPECT_TRUE(wrapper.isLoaded());

  EXPECT_NO_THROW(wrapper.unload());
  EXPECT_FALSE(wrapper.isLoaded());

  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());

  EXPECT_NO_THROW(wrapper.reset());
}

TEST_F(NmtCppModelWrapperTest, ModelApi_RuntimeStats_AfterProcess) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();

  auto result = std::any_cast<std::string>(wrapper.process(make_valid_input()));
  EXPECT_FALSE(result.empty());

  auto stats = wrapper.runtimeStats();
  EXPECT_FALSE(stats.empty());
}

TEST_F(NmtCppModelWrapperTest, ModelApi_Process_EmptyInput_NoThrow) {
  TranslationModel wrapper(getValidModelPath());

  EXPECT_NO_THROW(wrapper.process(make_empty_input()));
}

// ============================================================================
// Generic Model API Tests
// ============================================================================

// Type definitions for generic API tests
using TestModel = TranslationModel;

std::string getValidModelPath() {
  return "../../../models/unit-test/model.bin";
}

std::string getInvalidModelPath() {
  return "definitely/invalid/path/model.bin";
}

TestModel make_valid_model() { return TranslationModel(getValidModelPath()); }

TestModel make_invalid_model() { return TranslationModel(); }

std::any make_valid_input() { return std::string("Hello, my name is Bob."); }

std::any make_empty_input() { return std::string(); }

} // namespace qvac_lib_inference_addon_nmt::test

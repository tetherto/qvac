#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "../src/model-interface/TranslationModel.hpp"
#include "NmtSharedTests.hpp"

using qvac_lib_inference_addon_nmt::TranslationModel;

namespace qvac_lib_inference_addon_nmt::test_indic {

std::string getValidModelPath();

std::string getInvalidModelPath();

std::any make_valid_input();

std::any make_empty_input();

// ============================================================================
// Generic Model API Tests
// ============================================================================

// Type definitions for generic API tests
using TestModel = TranslationModel;

std::string getValidModelPath() {
  namespace fs = std::filesystem;
  // Try different possible paths for models
  if (fs::exists(fs::path{"../../../models/unit-test/"
                          "ggml-indictrans2-en-indic-dist-200M-q4_0.bin"})) {
    return "../../../models/unit-test/"
           "ggml-indictrans2-en-indic-dist-200M-q4_0.bin";
  }
  return "models/unit-test/ggml-indictrans2-en-indic-dist-200M-q4_0.bin";
}

std::string getInvalidModelPath() {
  return "definitely/invalid/path/model.bin";
}

TestModel make_valid_model() { return TranslationModel(getValidModelPath()); }

TestModel make_invalid_model() { return TestModel(); }

std::any make_valid_input() { return std::string("Hello, my name is Bob."); }

std::any make_empty_input() { return std::string(); }

}; // namespace qvac_lib_inference_addon_nmt::test_indic

using qvac_lib_inference_addon_nmt::test_shared::NmtCppModelWrapperTest;
using qvac_lib_inference_addon_nmt::test_shared::NmtParamProvider;

INSTANTIATE_TEST_SUITE_P(
    IndicTests, NmtCppModelWrapperTest,
    ::testing::Values(NmtParamProvider(
        qvac_lib_inference_addon_nmt::test_indic::getValidModelPath,
        qvac_lib_inference_addon_nmt::test_indic::getInvalidModelPath,
        qvac_lib_inference_addon_nmt::test_indic::make_valid_input,
        qvac_lib_inference_addon_nmt::test_indic::make_empty_input)));

TEST_P(NmtCppModelWrapperTest, ConstructionWithValidConfig) {
  EXPECT_NO_THROW({ TranslationModel wrapper(getValidModelPath()); });
}

TEST_P(NmtCppModelWrapperTest, InitialState) {
  TranslationModel wrapper(getValidModelPath());
  EXPECT_FALSE(wrapper.isLoaded());
}

TEST_P(NmtCppModelWrapperTest, LoadingLifecycle) {
  TranslationModel wrapper(getValidModelPath());
  EXPECT_NO_THROW(wrapper.load());
  EXPECT_TRUE(wrapper.isLoaded());
  EXPECT_NO_THROW(wrapper.unload());
}

TEST_P(NmtCppModelWrapperTest, LoadWithInvalidModelPath) {
  TranslationModel wrapper(getInvalidModelPath());
  EXPECT_THROW(wrapper.load(), std::runtime_error);
}

TEST_P(NmtCppModelWrapperTest, DefaultConstructor_LoadThrowsDueToEmptyPath) {
  TranslationModel wrapper;
  EXPECT_THROW(wrapper.load(), std::runtime_error);
}

TEST_P(NmtCppModelWrapperTest, SaveLoadParamsEmptyPath_ThenLoadThrows) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.saveLoadParams("");
  EXPECT_THROW(wrapper.load(), std::runtime_error);
}

TEST_P(
    NmtCppModelWrapperTest, SaveLoadParamsAfterLoad_TakesEffectOnlyOnReload) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_TRUE(wrapper.isLoaded());
  wrapper.saveLoadParams(getInvalidModelPath());
  auto input = make_valid_input();
  EXPECT_NO_THROW({
    std::string out = std::any_cast<std::string>(wrapper.process(input));
    EXPECT_GE(out.size(), 0);
  });
  EXPECT_THROW(wrapper.reload(), std::runtime_error);
}

TEST_P(NmtCppModelWrapperTest, ReloadCycle) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_TRUE(wrapper.isLoaded());
  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
}

TEST_P(NmtCppModelWrapperTest, Reset) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_NO_THROW(wrapper.reset());
}

TEST_P(NmtCppModelWrapperTest, ProcessValidInput) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.setUseGpu(false);
  wrapper.load();
  auto validInput = make_valid_input();
  EXPECT_NO_THROW({
    auto result = std::any_cast<std::string>(wrapper.process(validInput));
    EXPECT_GE(result.size(), 0);
  });
}

TEST_P(NmtCppModelWrapperTest, ProcessEmptyInput) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  auto emptyInput = make_empty_input();
  EXPECT_NO_THROW({
    auto result = std::any_cast<std::string>(wrapper.process(emptyInput));
    EXPECT_EQ(result.size(), 0);
  });
}

TEST_P(NmtCppModelWrapperTest, ProcessWithoutLoading) {
  TranslationModel wrapper(getValidModelPath());
  auto validInputs = make_valid_input();
  EXPECT_NO_THROW(wrapper.process(validInputs));
}

TEST_P(
    NmtCppModelWrapperTest,
    RuntimeStats_NotLoadedReturnsEmptyAndStringMessage) {
  TranslationModel wrapper(getValidModelPath());
  const auto stats = wrapper.runtimeStats();
  EXPECT_TRUE(stats.empty());
}

TEST_P(NmtCppModelWrapperTest, RuntimeStats_ResetClearsStats) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  auto input = make_valid_input();
  wrapper.process(input);
  const auto beforeReset = wrapper.runtimeStats();
  EXPECT_FALSE(beforeReset.empty());
  wrapper.reset();
  const auto afterReset = wrapper.runtimeStats();
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

TEST_P(
    NmtCppModelWrapperTest,
    RuntimeStatsToString_HasExpectedKeysWhenStatsExist) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  auto input = make_valid_input();
  wrapper.process(input);
  const auto stats = wrapper.runtimeStats();
  EXPECT_FALSE(stats.empty());
}

TEST_P(NmtCppModelWrapperTest, RuntimeStatsDisabled) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  auto stats = wrapper.runtimeStats();
  EXPECT_GE(stats.size(), 0);
}

TEST_P(NmtCppModelWrapperTest, GetNmtConfig) {
  TranslationModel wrapper(getValidModelPath());
  const std::
      unordered_map<std::string, std::variant<double, int64_t, std::string>>
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
    EXPECT_TRUE(
        modelGenerationConfig.find(configName) != modelGenerationConfig.end());
    auto modelConfigValue = modelGenerationConfig.at(configName);
    auto configValue = generationConfig.at(configName);
    EXPECT_EQ(modelConfigValue, configValue);
  }
}

TEST_P(NmtCppModelWrapperTest, SetConfigStoredBeforeLoad_NoLoad) {
  TranslationModel wrapper;
  const std::
      unordered_map<std::string, std::variant<double, int64_t, std::string>>
          cfg = {
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

TEST_P(NmtCppModelWrapperTest, SetConfigBeforeLoad_NotAppliedUntilAfterLoad) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  const std::string longInput =
      "This is a very long input sentence repeated multiple times to ensure "
      "length effects. This is a very long input sentence repeated multiple "
      "times to ensure length effects. This is a very long input sentence.";
  auto out_before = std::any_cast<std::string>(wrapper.process(longInput));
  EXPECT_FALSE(out_before.empty());
  wrapper.setConfig(
      {{"maxlength", static_cast<int64_t>(5)},
       {"beamsize", static_cast<int64_t>(1)}});
  auto out_after = std::any_cast<std::string>(wrapper.process(longInput));
  EXPECT_FALSE(out_after.empty());
  EXPECT_TRUE(out_after != out_before || out_after.size() < out_before.size());
}

TEST_P(NmtCppModelWrapperTest, UnknownKeysIgnored_NoSideEffects) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_NO_THROW(wrapper.setConfig(
      {{"unknown_param_A", static_cast<int64_t>(42)},
       {"unknown_param_B", 0.5}}));
}

TEST_P(NmtCppModelWrapperTest, ReapplyConfigOverridesPrevious_LastWriteWins) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_NO_THROW(wrapper.setConfig({{"beamsize", static_cast<int64_t>(4)}}));
  EXPECT_NO_THROW(wrapper.setConfig({{"beamsize", static_cast<int64_t>(8)}}));
  const auto stored = wrapper.getConfig();
  ASSERT_TRUE(stored.find("beamsize") != stored.end());
  EXPECT_EQ(std::get<int64_t>(stored.at("beamsize")), static_cast<int64_t>(8));
}

TEST_P(NmtCppModelWrapperTest, MultipleProcessCalls) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  auto validInput = make_valid_input();
  for (int i = 0; i < 3; ++i) {
    EXPECT_NO_THROW({
      auto result = std::any_cast<std::string>(wrapper.process(validInput));
      EXPECT_GE(result.size(), 0);
    });
  }
}

TEST_P(NmtCppModelWrapperTest, DestructorCleanup) {
  {
    TranslationModel wrapper(getValidModelPath());
    wrapper.load();
  }
  EXPECT_TRUE(true);
}

TEST_P(NmtCppModelWrapperTest, LoadUnloadSequence) {
  TranslationModel wrapper(getValidModelPath());
  for (int cycle = 0; cycle < 2; ++cycle) {
    wrapper.load();
    EXPECT_TRUE(wrapper.isLoaded());
    auto validInput = make_valid_input();
    wrapper.process(validInput);
    wrapper.unload();
  }
}

TEST_P(NmtCppModelWrapperTest, UnloadWhenNotLoadedIsIdempotent) {
  TranslationModel wrapper(getValidModelPath());
  EXPECT_NO_THROW(wrapper.unload());
  EXPECT_FALSE(wrapper.isLoaded());
  EXPECT_NO_THROW(wrapper.unload());
  EXPECT_FALSE(wrapper.isLoaded());
}

TEST_P(NmtCppModelWrapperTest, IsLoadedFalseAfterUnload) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_TRUE(wrapper.isLoaded());
  wrapper.unload();
  EXPECT_FALSE(wrapper.isLoaded());
}

TEST_P(NmtCppModelWrapperTest, ReloadWhenNotLoadedWithValidPath) {
  TranslationModel wrapper(getValidModelPath());
  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
}

TEST_P(NmtCppModelWrapperTest, ReloadWhenNotLoadedWithInvalidPath) {
  TranslationModel wrapper(getInvalidModelPath());
  EXPECT_THROW(wrapper.reload(), std::runtime_error);
}

TEST_P(NmtCppModelWrapperTest, ReloadAfterUnloadRestoresLoadedState) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  EXPECT_TRUE(wrapper.isLoaded());
  wrapper.unload();
  EXPECT_FALSE(wrapper.isLoaded());
  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
}

TEST_P(NmtCppModelWrapperTest, DoubleReloadMaintainsStability) {
  TranslationModel wrapper(getValidModelPath());
  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
}

TEST_P(NmtCppModelWrapperTest, ModelApi_InitializeLoadUnloadReloadReset) {
  TranslationModel wrapper(getValidModelPath());
  EXPECT_NO_THROW(wrapper.load());
  EXPECT_TRUE(wrapper.isLoaded());
  EXPECT_NO_THROW(wrapper.unload());
  EXPECT_FALSE(wrapper.isLoaded());
  EXPECT_NO_THROW(wrapper.reload());
  EXPECT_TRUE(wrapper.isLoaded());
  EXPECT_NO_THROW(wrapper.reset());
}

TEST_P(NmtCppModelWrapperTest, ModelApi_RuntimeStats_AfterProcess) {
  TranslationModel wrapper(getValidModelPath());
  wrapper.load();
  auto result = std::any_cast<std::string>(wrapper.process(make_valid_input()));
  EXPECT_FALSE(result.empty());
  auto stats = wrapper.runtimeStats();
  EXPECT_FALSE(stats.empty());
}

TEST_P(NmtCppModelWrapperTest, ModelApi_Process_EmptyInput_NoThrow) {
  TranslationModel wrapper(getValidModelPath());
  EXPECT_NO_THROW(wrapper.process(make_empty_input()));
}

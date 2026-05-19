#include <any>
#include <filesystem>
#include <iostream>
#include <memory>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "test_prompt_helpers.hpp"

namespace fs = std::filesystem;

using test_common::getStatValue;
using test_common::processPromptString;
using test_common::processPromptWithCacheOptions;

class CacheManagementTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    test_model_path = test_common::BaseTestModelPath::get();
    test_projection_path = "";

    config_files["backendsDir"] = test_common::getTestBackendsDir().string();

    session1_path = "test_session1.bin";
    session2_path = "test_session2.bin";
    temp_session_path = "temp_session.bin";
  }

  void TearDown() override {
    for (const auto& session_file :
         {session1_path,
          session2_path,
          temp_session_path,
          std::string("test_large_cache.bin")}) {
      if (fs::exists(session_file)) {
        fs::remove(session_file);
      }
    }
  }

  bool hasValidModel() { return fs::exists(test_model_path); }

  std::unique_ptr<LlamaModel> createModel() {
    if (!hasValidModel()) {
      return nullptr;
    }
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    auto configCopy = config_files;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath), std::move(projectionPath), std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unique_ptr<LlamaModel>
  createModelWithContextSize(const std::string& ctxSize) {
    if (!hasValidModel()) {
      return nullptr;
    }
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    std::unordered_map<std::string, std::string> custom_config = config_files;
    custom_config["ctx_size"] = ctxSize;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath),
        std::move(projectionPath),
        std::move(custom_config));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unique_ptr<LlamaModel> createModelWithContextSizeAndNPredict(
      const std::string& ctxSize, const std::string& nPredict) {
    if (!hasValidModel()) {
      return nullptr;
    }
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    std::unordered_map<std::string, std::string> custom_config = config_files;
    custom_config["ctx_size"] = ctxSize;
    custom_config["n_predict"] = nPredict;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath),
        std::move(projectionPath),
        std::move(custom_config));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;
  std::string session1_path;
  std::string session2_path;
  std::string temp_session_path;
};

TEST_F(CacheManagementTest, InitialStateNoCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptString(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])");
    EXPECT_FALSE(output.empty());
  });

  EXPECT_FALSE(fs::exists(session1_path));
}

TEST_F(CacheManagementTest, EnableCacheWithFilename) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])",
        session1_path,
        true);
    EXPECT_FALSE(output.empty());
  });

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementTest, SessionPersistence) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output1 = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path,
        true);
    EXPECT_FALSE(output1.empty());
  });

  EXPECT_TRUE(fs::exists(session1_path));

  EXPECT_NO_THROW({
    std::string output2 = processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What did I ask you before? Answer shortly."}])",
        session1_path,
        true);
    EXPECT_FALSE(output2.empty());
  });

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementTest, SwitchToSession2) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What did I ask you before? Answer shortly."}])",
        session2_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));
  EXPECT_TRUE(fs::exists(session2_path));
}

TEST_F(CacheManagementTest, DisableCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path);
  });

  EXPECT_NO_THROW({
    std::string output2 = processPromptString(
        model,
        R"([{"role": "user", "content": "What is blockchain? Answer shortly."}])");
    EXPECT_FALSE(output2.empty());
  });
}

TEST_F(CacheManagementTest, VerifyStatelessBehavior) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output1 = processPromptString(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])");
    EXPECT_FALSE(output1.empty());
    auto stats1 = model->runtimeStats();
    EXPECT_GE(getStatValue(stats1, "promptTokens"), 0.0);
  });

  EXPECT_NO_THROW({
    std::string output2 = processPromptString(
        model,
        R"([{"role": "user", "content": "What did I ask you before? Answer shortly."}])");
    EXPECT_FALSE(output2.empty());
    auto stats2 = model->runtimeStats();
    EXPECT_GE(getStatValue(stats2, "promptTokens"), 0.0);
  });
}

TEST_F(CacheManagementTest, ReEnableCacheAfterDisable) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output1 = processPromptString(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])");
    EXPECT_FALSE(output1.empty());
  });

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is deep learning? Answer shortly."}])",
        temp_session_path,
        true);
  });

  EXPECT_TRUE(fs::exists(temp_session_path));
}

TEST_F(CacheManagementTest, SwitchAndResetChain) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path,
        true);
  });

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])",
        session2_path,
        true);
  });

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is blockchain? Answer shortly."}])",
        session1_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));
  EXPECT_TRUE(fs::exists(session2_path));
}

TEST_F(CacheManagementTest, CacheClearedWhenNoCacheKey) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  EXPECT_NO_THROW({
    processPromptString(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])");
  });

  EXPECT_TRUE(fs::exists(session1_path));

  auto stats = model->runtimeStats();
  EXPECT_EQ(getStatValue(stats, "CacheTokens"), 0.0);

  qvac_lib_inference_addon_cpp::RuntimeStats stats3;
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is blockchain? Answer shortly."}])",
        session1_path);
    stats3 = model->runtimeStats();
  });

  double cacheTokens3 = getStatValue(stats3, "CacheTokens");
  EXPECT_GT(cacheTokens3, 0.0);
}

TEST_F(CacheManagementTest, CacheClearedWhenSwitchingToDifferentCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])",
        session2_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  auto stats2 = model->runtimeStats();
  EXPECT_GT(getStatValue(stats2, "CacheTokens"), 0.0);
  EXPECT_TRUE(fs::exists(session2_path));
}

TEST_F(CacheManagementTest, SingleShotInferenceAfterCacheCleared) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path);
  });

  auto stats1 = model->runtimeStats();
  double cacheTokens1 = getStatValue(stats1, "CacheTokens");

  EXPECT_NO_THROW({
    processPromptString(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])");
  });

  auto stats2 = model->runtimeStats();
  double cacheTokens2 = getStatValue(stats2, "CacheTokens");
  EXPECT_GT(cacheTokens1, 0.0);
  EXPECT_EQ(cacheTokens2, 0.0);
}

TEST_F(CacheManagementTest, CacheToNoCacheToCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  EXPECT_NO_THROW({
    processPromptString(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])");
    auto stats2 = model->runtimeStats();
    EXPECT_EQ(getStatValue(stats2, "CacheTokens"), 0.0);
  });

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is blockchain? Answer shortly."}])",
        session2_path,
        true);
    auto stats3 = model->runtimeStats();
    EXPECT_GT(getStatValue(stats3, "CacheTokens"), 0.0);
  });

  EXPECT_TRUE(fs::exists(session1_path));
  EXPECT_TRUE(fs::exists(session2_path));
}

TEST_F(CacheManagementTest, CacheTokensExceedContextSize) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  std::string large_cache_path = "test_large_cache.bin";

  auto model_large = createModelWithContextSizeAndNPredict("4096", "100");
  if (!model_large) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model_large,
        R"([{"role": "user", "content": "What is bitcoin? Please provide a detailed explanation of how bitcoin works, including its blockchain technology, mining process, and cryptographic principles. Explain the concept of distributed consensus and how transactions are verified."}])",
        large_cache_path);
  });

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model_large,
        R"([{"role": "user", "content": "Now explain ethereum in similar detail. Include information about smart contracts, the EVM, gas fees, and how it differs from bitcoin."}])",
        large_cache_path);
  });

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model_large,
        R"([{"role": "user", "content": "Finally, explain blockchain technology in general, covering concepts like immutability, decentralization, consensus mechanisms, and potential use cases beyond cryptocurrencies."}])",
        large_cache_path);
  });

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model_large,
        R"([{"role": "user", "content": "Explain proof of work and proof of stake consensus mechanisms in detail. Compare and contrast their advantages and disadvantages."}])",
        large_cache_path);
  });

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model_large,
        R"([{"role": "user", "content": "Describe DeFi (Decentralized Finance) applications, including DEXs, lending protocols, and yield farming. Explain how they work and their risks."}])",
        large_cache_path,
        true);
  });

  auto statsBeforeSave = model_large->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);
  EXPECT_TRUE(fs::exists(large_cache_path));

  model_large.reset();

  int smallContextSize = 128;
  if (cacheTokensBeforeSave <= smallContextSize) {
    FAIL() << "Cache tokens (" << cacheTokensBeforeSave
           << ") not enough to exceed context size (" << smallContextSize
           << ")";
  }

  auto model_small =
      createModelWithContextSize(std::to_string(smallContextSize));
  if (!model_small) {
    FAIL() << "Model failed to load";
  }

  EXPECT_THROW(
      {
        processPromptWithCacheOptions(
            model_small,
            R"([{"role": "user", "content": "Test"}])",
            large_cache_path);
      },
      qvac_errors::StatusError);
}

TEST_F(CacheManagementTest, CacheWithToolsCompactFalseSavesFullCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "false";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])",
        session1_path,
        true);
  });

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);

  EXPECT_TRUE(fs::exists(session1_path));
}

TEST_F(CacheManagementTest, OptionsNoPersistKeepsRamOnly) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin?"}])",
        session1_path);
  });

  EXPECT_FALSE(fs::exists(session1_path));

  auto stats = model->runtimeStats();
  double cacheTokens = getStatValue(stats, "CacheTokens");
  EXPECT_GT(cacheTokens, 0.0);
}

TEST_F(CacheManagementTest, ResetTrueOnFirstCallWithNoPriorCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin?"}])",
        session1_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session1_path));

  auto stats = model->runtimeStats();
  EXPECT_GT(getStatValue(stats, "CacheTokens"), 0.0);
}

TEST_F(CacheManagementTest, ResetTrueWithDifferentCacheKey) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin?"}])",
        session1_path,
        true);
  });

  auto stats1 = model->runtimeStats();
  double cacheTokens1 = getStatValue(stats1, "CacheTokens");
  EXPECT_GT(cacheTokens1, 0.0);

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "Fresh start."}])",
        session2_path,
        true);
  });

  auto stats2 = model->runtimeStats();
  double cacheTokens2 = getStatValue(stats2, "CacheTokens");
  EXPECT_GT(cacheTokens2, 0.0);
  EXPECT_TRUE(fs::exists(session1_path));
  EXPECT_TRUE(fs::exists(session2_path));
}

TEST_F(CacheManagementTest, PersistToWithNoCacheKeyIsNoOp) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin?"}])",
        "",
        true);
  });

  EXPECT_FALSE(fs::exists(session1_path));

  auto stats = model->runtimeStats();
  EXPECT_EQ(getStatValue(stats, "CacheTokens"), 0.0);
}

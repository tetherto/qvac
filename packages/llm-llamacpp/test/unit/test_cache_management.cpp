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
      std::string tmp = session_file + ".tmp";
      if (fs::exists(tmp)) {
        fs::remove(tmp);
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

TEST_F(CacheManagementTest, AtomicWriteLeavesNoTmpArtifact) {
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

  // writeCacheFile writes to session1_path+".tmp" then renames to
  // session1_path. The canonical file must exist and the tmp must be gone.
  EXPECT_TRUE(fs::exists(session1_path));
  EXPECT_FALSE(fs::exists(session1_path + ".tmp"));
}

TEST_F(CacheManagementTest, SaveFailureThrowsAndRemovesTmp) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  // A path whose parent directory does not exist forces llama_state_save_file
  // to fail, exercising the throw path in writeCacheFile.
  const std::string bad_path = "/tmp/qvac_test_no_such_dir/session.bin";

  try {
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path, true);
    FAIL() << "expected UnableToSaveSessionFile throw";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(
        std::string(e.codeString()).find("UnableToSaveSessionFile"),
        std::string::npos);
  }

  EXPECT_FALSE(fs::exists(bad_path + ".tmp"));
  EXPECT_FALSE(fs::exists(bad_path));
}

TEST_F(CacheManagementTest, HandleCacheSwitchFailureInvalidatesState) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  // Prime the CacheManager with a key in a non-existent dir. No write yet
  // (saveCacheToDisk=false) — this just registers sessionPath_.
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "hi"}])",
        "/tmp/qvac_test_no_such_dir_a/session.bin",
        false);
  });

  // Trigger a cache-switch: handleCache flushes the old key to a
  // non-existent directory → throws UnableToSaveSessionFile.
  // With the invalidate-on-throw fix, state is left clean (disabled).
  try {
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "hi"}])",
        "/tmp/qvac_test_no_such_dir_b/session.bin",
        false);
    FAIL() << "expected UnableToSaveSessionFile throw";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(
        std::string(e.codeString()).find("UnableToSaveSessionFile"),
        std::string::npos);
  }

  // After invalidate(), a prompt with no cacheKey must not re-attempt the
  // stale flush. If invalidate() was NOT called, hasActiveCache() would still
  // be true and the clear path would throw a second time here.
  EXPECT_NO_THROW({
    processPromptString(model, R"([{"role": "user", "content": "hi"}])");
  });
}

TEST_F(CacheManagementTest, HandleCacheClearFailureInvalidatesState) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  // Prime with a key in a non-existent dir (no write yet).
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "hi"}])",
        "/tmp/qvac_test_no_such_dir_a/session.bin",
        false);
  });

  // Trigger the cache-clear path (empty cacheKey): handleCache flushes the
  // active key to a non-existent directory → throws UnableToSaveSessionFile.
  try {
    processPromptString(model, R"([{"role": "user", "content": "hi"}])");
    FAIL() << "expected UnableToSaveSessionFile throw";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(
        std::string(e.codeString()).find("UnableToSaveSessionFile"),
        std::string::npos);
  }

  // After invalidate(), the CacheManager is disabled. A second no-cacheKey
  // prompt must not re-attempt the flush (hasActiveCache() is now false).
  EXPECT_NO_THROW({
    processPromptString(model, R"([{"role": "user", "content": "hi"}])");
  });
}

TEST_F(CacheManagementTest, HandleCacheSwitchFailureRetryWithNewKeySucceeds) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  // Prime with a key in a non-existent dir (no write) — registers sessionPath_.
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "hi"}])",
        "/tmp/qvac_test_no_such_dir_a/session.bin",
        false);
  });

  // Switch to another bad key — flushes the old key to a non-existent dir →
  // throws UnableToSaveSessionFile.
  try {
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "hi"}])",
        "/tmp/qvac_test_no_such_dir_b/session.bin",
        false);
    FAIL() << "expected UnableToSaveSessionFile throw";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(
        std::string(e.codeString()).find("UnableToSaveSessionFile"),
        std::string::npos);
  }

  // After resetStateCallback_ + invalidate(), retrying with a valid key must
  // succeed and run inference on fresh KV, not stale in-memory state.
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", session2_path, false);
    auto stats = model->runtimeStats();
    EXPECT_GE(getStatValue(stats, "CacheTokens"), 0.0);
  });
}

TEST_F(CacheManagementTest, AtomicWriteOverwriteExistingFile) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  // First save — creates session1_path.
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        session1_path,
        true);
  });
  EXPECT_TRUE(fs::exists(session1_path));
  EXPECT_FALSE(fs::exists(session1_path + ".tmp"));

  // Second save — overwrites the existing canonical file (exercises the
  // rename-over-existing path, which fails on Windows without the fallback).
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])",
        session1_path,
        true);
  });
  EXPECT_TRUE(fs::exists(session1_path));
  EXPECT_FALSE(fs::exists(session1_path + ".tmp"));
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

TEST_F(CacheManagementTest, StaleCacheResidencyInvalidatedByBatchSlot) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  // Set up parallel > 1 to activate the batch scheduler.
  config_files["parallel"] = "4";
  config_files["ctx_size"] = "512"; // Keep small for faster tests
  config_files["n_predict"] = "10";
  config_files["temp"] = "0";

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string cacheFile = "test_stale_residency.bin";
  if (fs::exists(cacheFile)) {
    fs::remove(cacheFile);
  }

  // 1. Seed the cache file using the single-prompt path.
  std::string singlePrompt =
      R"([{"role": "user", "content": "The sky is blue. What color is the sky?"}])";
  std::string response1 =
      processPromptWithCacheOptions(model, singlePrompt, cacheFile, true);
  ASSERT_FALSE(response1.empty());
  ASSERT_TRUE(fs::exists(cacheFile));

  // 2. Submit a batch prompt. The scheduler's first slot will occupy seq 0,
  // execute, and upon completion clear seq 0's KV cells.
  LlamaModel::Prompt batchPrompt;
  batchPrompt.input = R"([{"role": "user", "content": "Count from 1 to 3."}])";
  auto batchOutputs = model->processPromptBatch(
      std::vector<LlamaModel::Prompt>{std::move(batchPrompt)});
  ASSERT_EQ(batchOutputs.size(), 1u);
  ASSERT_FALSE(batchOutputs[0].empty());

  // 3. Run a subsequent single-prompt with the same cache file.
  // The CacheManager must detect that seq 0 was wiped (or simply invalidate its
  // state) and force a reload from disk, leading to a valid completion.
  std::string response2 = processPromptWithCacheOptions(
      model,
      R"([{"role": "user", "content": "What color did I say the sky was?"}])",
      cacheFile,
      false);

  // Clean up cache file.
  if (fs::exists(cacheFile)) {
    fs::remove(cacheFile);
  }

  // Assert response is valid and correctly remembers the context from the
  // loaded cache.
  EXPECT_FALSE(response2.empty())
      << "STALE CACHE RESIDENCY BUG: CacheManager believed the cache was "
         "resident in seq 0 "
         "even though the batch scheduler occupied and wiped seq 0. "
         "processPrompt returned empty output.";
}

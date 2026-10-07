#include <algorithm>
#include <any>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include "model-interface/LlamaModel.hpp"
#include "model-interface/SequenceDriver.hpp"
#include "model-interface/TextLlmContext.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"
#include "test_prompt_helpers.hpp"
#include "utils/SequenceStateSnapshot.hpp"

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
    for (const auto& session_dir :
         {std::string("deleted_cache_dir"),
          std::string("cache_target_dir_a"),
          std::string("cache_target_dir_b")}) {
      fs::remove_all(session_dir);
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
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}, {"role": "assistant", "content": "Bitcoin is a decentralized digital currency."}, {"role": "user", "content": "What did I ask you before? Answer shortly."}])",
        session1_path,
        true);
    EXPECT_FALSE(output2.empty());
  });

  EXPECT_TRUE(fs::exists(session1_path));
}

// A generation that stops at `n_predict` is a completed request from the
// caller's side: the answer was streamed. Its tokens therefore stay resident
// and the transaction commits, so the next full-history turn reuses them
// instead of re-prefilling the answer the model just produced.
TEST_F(CacheManagementTest, PredictionLimitGenerationCommitsCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const auto readBytes = [](const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    return std::string(
        (std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  };
  const std::string history =
      R"([{"role": "user", "content": "Explain how bitcoin mining works in detail."}])";

  // Seed with a prefill-only turn so the pre-request cursor is known.
  LlamaModel::Prompt seed;
  seed.input = history;
  seed.prefill = true;
  seed.cacheKey = session1_path;
  ASSERT_TRUE(model->processPrompt(seed).empty());
  model->saveCache(session1_path);
  ASSERT_TRUE(fs::exists(session1_path));
  const double seededTokens =
      getStatValue(model->runtimeStats(), "CacheTokens");
  ASSERT_GT(seededTokens, 0.0);
  const std::string seededBytes = readBytes(session1_path);

  // Fixture n_predict is 10, so this generation stops at the prediction
  // limit long before the model finishes its answer.
  const std::string output =
      processPromptWithCacheOptions(model, history, session1_path, true);
  EXPECT_FALSE(output.empty());
  EXPECT_EQ(
      getStatValue(model->runtimeStats(), "stopReason"),
      static_cast<double>(GenerationStopReason::PredictionLimit));
  EXPECT_GT(getStatValue(model->runtimeStats(), "CacheTokens"), seededTokens)
      << "prediction-limit generation must commit its tokens, not roll back";
  EXPECT_NE(readBytes(session1_path), seededBytes)
      << "the committed generation must be persisted under cacheKey";
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
        R"([{"role": "user", "content": "What is bitcoin? Please provide a detailed explanation of how bitcoin works, including its blockchain technology, mining process, and cryptographic principles. Explain distributed consensus and how transactions are verified."}, {"role": "assistant", "content": "Bitcoin uses a distributed ledger, proof of work, signed transactions, and independently validating nodes."}, {"role": "user", "content": "Now explain ethereum in similar detail. Include smart contracts, the EVM, gas fees, and how it differs from bitcoin."}, {"role": "assistant", "content": "Ethereum is a programmable blockchain whose EVM executes smart contracts and charges gas for computation."}, {"role": "user", "content": "Explain blockchain technology in general, including immutability, decentralization, consensus mechanisms, and uses beyond cryptocurrencies."}, {"role": "assistant", "content": "Blockchains replicate an append-only history across participants that agree on updates through a consensus protocol."}, {"role": "user", "content": "Compare proof of work and proof of stake, including their advantages and disadvantages."}, {"role": "assistant", "content": "Proof of work commits computation and energy, while proof of stake commits slashable capital."}, {"role": "user", "content": "Describe decentralized finance applications, including exchanges, lending protocols, yield farming, and their risks."}])",
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

TEST_F(CacheManagementTest, CacheWithToolPromptSavesFullCache) {
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
        R"([{"role": "user", "content": "What is the weather in Tokyo?"}, {"type": "function", "name": "getWeather", "description": "Get weather forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}])",
        session1_path,
        true);
  });

  auto statsBeforeSave = model->runtimeStats();
  double cacheTokensBeforeSave = getStatValue(statsBeforeSave, "CacheTokens");
  EXPECT_GT(cacheTokensBeforeSave, 0.0);

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

TEST_F(CacheManagementTest, SwitchAfterCacheDirectoryDeletedUsesNewKey) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const fs::path deleted_cache_dir = "deleted_cache_dir";
  const std::string deleted_cache_path =
      (deleted_cache_dir / "session.bin").string();

  fs::remove_all(deleted_cache_dir);
  fs::create_directories(deleted_cache_dir);

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        deleted_cache_path,
        true);
  });
  EXPECT_TRUE(fs::exists(deleted_cache_path));

  fs::remove_all(deleted_cache_dir);

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])",
        session2_path,
        true);
  });

  EXPECT_TRUE(fs::exists(session2_path));
  EXPECT_FALSE(fs::exists(deleted_cache_dir));

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What did I just ask about? Answer shortly."}])",
        session2_path,
        true);
  });

  auto stats = model->runtimeStats();
  EXPECT_GT(getStatValue(stats, "CacheTokens"), 0.0);
}

TEST_F(CacheManagementTest, SameKeyAfterCacheFileDeletedStartsFresh) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const fs::path deleted_cache_dir = "deleted_cache_dir";
  const std::string deleted_cache_path =
      (deleted_cache_dir / "session.bin").string();

  fs::remove_all(deleted_cache_dir);
  fs::create_directories(deleted_cache_dir);

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "Explain bitcoin, ethereum, and blockchain in three concise bullet points."}])",
        deleted_cache_path,
        true);
  });

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);
  const llama_pos firstNPast = llama_memory_seq_pos_max(mem, 0) + 1;
  ASSERT_GT(firstNPast, 0);
  EXPECT_TRUE(fs::exists(deleted_cache_path));

  fs::remove_all(deleted_cache_dir);
  fs::create_directories(deleted_cache_dir);

  LlamaModel::Prompt prompt;
  prompt.prefill = true;
  prompt.input = R"([{"role": "user", "content": "Hi."}])";
  prompt.cacheKey = deleted_cache_path;

  EXPECT_NO_THROW({ model->processPrompt(prompt); });
  EXPECT_NO_THROW({ model->saveCache(deleted_cache_path); });

  const llama_pos secondNPast = llama_memory_seq_pos_max(mem, 0) + 1;
  EXPECT_GT(secondNPast, 0);
  EXPECT_LT(secondNPast, firstNPast)
      << "same-key reuse after cache deletion kept stale in-memory KV state";
  EXPECT_TRUE(fs::exists(deleted_cache_path));
}

TEST_F(CacheManagementTest, ClearAfterCacheDirectoryDeletedDisablesCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const fs::path deleted_cache_dir = "deleted_cache_dir";
  const std::string deleted_cache_path =
      (deleted_cache_dir / "session.bin").string();

  fs::remove_all(deleted_cache_dir);
  fs::create_directories(deleted_cache_dir);

  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is bitcoin? Answer shortly."}])",
        deleted_cache_path,
        true);
  });
  EXPECT_TRUE(fs::exists(deleted_cache_path));

  fs::remove_all(deleted_cache_dir);

  EXPECT_NO_THROW({
    processPromptString(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])");
  });

  EXPECT_FALSE(fs::exists(deleted_cache_dir));
  EXPECT_FALSE(fs::exists(session2_path));
}

TEST_F(CacheManagementTest, UnsavedMissingParentSwitchStillThrows) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const fs::path bad_cache_dir_a =
      fs::temp_directory_path() / "qvac_test_no_such_dir_a";
  const fs::path bad_cache_dir_b =
      fs::temp_directory_path() / "qvac_test_no_such_dir_b";
  const std::string bad_path_a = (bad_cache_dir_a / "session.bin").string();
  const std::string bad_path_b = (bad_cache_dir_b / "session.bin").string();

  fs::remove_all(bad_cache_dir_a);
  fs::remove_all(bad_cache_dir_b);

  // This registers an active RAM-only cache path without ever writing a backing
  // file. A missing parent is therefore still a bad save path, not an
  // externally deleted persisted cache.
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path_a, false);
  });

  try {
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path_b, false);
    FAIL() << "expected UnableToSaveSessionFile throw";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(
        std::string(e.codeString()).find("UnableToSaveSessionFile"),
        std::string::npos);
  }

  EXPECT_FALSE(fs::exists(bad_cache_dir_a));
  EXPECT_FALSE(fs::exists(bad_cache_dir_b));
}

TEST_F(CacheManagementTest, UnsavedMissingParentClearStillThrows) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const fs::path bad_cache_dir =
      fs::temp_directory_path() / "qvac_test_no_such_dir_clear";
  const std::string bad_path = (bad_cache_dir / "session.bin").string();

  fs::remove_all(bad_cache_dir);

  // This registers an active RAM-only cache path without ever writing a backing
  // file. Clearing the cache must still surface the failed flush.
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path, false);
  });

  try {
    processPromptString(model, R"([{"role": "user", "content": "hi"}])");
    FAIL() << "expected UnableToSaveSessionFile throw";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(
        std::string(e.codeString()).find("UnableToSaveSessionFile"),
        std::string::npos);
  }

  EXPECT_FALSE(fs::exists(bad_cache_dir));
}

TEST_F(CacheManagementTest, PersistedCachePathReplacedByDirectoryStillThrows) {
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
  ASSERT_TRUE(fs::exists(session1_path));

  fs::remove(session1_path);
  fs::create_directory(session1_path);

  try {
    processPromptWithCacheOptions(
        model,
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])",
        session2_path,
        false);
    FAIL() << "expected UnableToSaveSessionFile throw";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(
        std::string(e.codeString()).find("UnableToSaveSessionFile"),
        std::string::npos);
  }

  EXPECT_TRUE(fs::is_directory(session1_path));
  EXPECT_FALSE(fs::exists(session2_path));
}

TEST_F(CacheManagementTest, HandleCacheSwitchFailureInvalidatesState) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const std::string bad_path_a = "cache_target_dir_a";
  const std::string bad_path_b = "cache_target_dir_b";
  fs::create_directories(bad_path_a);
  fs::create_directories(bad_path_b);

  // Prime the CacheManager with a directory path. No write yet
  // (no saveCache) — this just registers sessionPath_.
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path_a, false);
  });

  // Trigger a cache-switch: handleCache flushes the old key to a
  // directory path, so promotion fails with UnableToSaveSessionFile.
  // With the invalidate-on-throw fix, state is left clean (disabled).
  try {
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path_b, false);
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

  const std::string bad_path = "cache_target_dir_a";
  fs::create_directories(bad_path);

  // Prime with a directory path (no write yet).
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path, false);
  });

  // Trigger the cache-clear path (empty cacheKey): handleCache flushes the
  // active key to a directory path → throws UnableToSaveSessionFile.
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

  const std::string bad_path_a = "cache_target_dir_a";
  const std::string bad_path_b = "cache_target_dir_b";
  fs::create_directories(bad_path_a);
  fs::create_directories(bad_path_b);

  // Prime with a directory path (no write) — registers sessionPath_.
  EXPECT_NO_THROW({
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path_a, false);
  });

  // Switch to another bad key — flushes the old key to a directory path →
  // throws UnableToSaveSessionFile.
  try {
    processPromptWithCacheOptions(
        model, R"([{"role": "user", "content": "hi"}])", bad_path_b, false);
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
    LlamaModel::Prompt prompt;
    prompt.input = R"([{"role": "user", "content": "What is bitcoin?"}])";
    model->processPrompt(prompt);
  });
  EXPECT_THROW(model->saveCache(""), qvac_errors::StatusError);

  EXPECT_FALSE(fs::exists(session1_path));

  auto stats = model->runtimeStats();
  EXPECT_EQ(getStatValue(stats, "CacheTokens"), 0.0);
}

TEST_F(CacheManagementTest, CorruptCacheTokenMetadataThrowsAndCleansMemory) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt seedPrompt;
  seedPrompt.prefill = true;
  seedPrompt.input =
      R"([{"role": "user", "content": "Seed full cache metadata."}])";
  ASSERT_NO_THROW({ model->processPrompt(seedPrompt); });

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);
  const llama_pos nPast = llama_memory_seq_pos_max(mem, 0) + 1;
  ASSERT_GT(nPast, 0);

  llama_token badMetadata[4] = {
      static_cast<llama_token>(nPast),
      static_cast<llama_token>(1),
      static_cast<llama_token>(nPast + 7),
      static_cast<llama_token>(1)};
  ASSERT_TRUE(llama_state_save_file(
      model->getContext(), temp_session_path.c_str(), badMetadata, 4));

  model->reset();
  ASSERT_EQ(llama_memory_seq_pos_max(mem, 0), -1);

  LlamaModel::Prompt loadPrompt;
  loadPrompt.input =
      R"([{"role": "user", "content": "This load should fail."}])";
  loadPrompt.cacheKey = temp_session_path;

  EXPECT_THROW({ model->processPrompt(loadPrompt); }, qvac_errors::StatusError);
  EXPECT_EQ(llama_memory_seq_pos_max(mem, 0), -1)
      << "failed full-cache metadata validation left KV rows resident";
  EXPECT_EQ(getStatValue(model->runtimeStats(), "CacheTokens"), 0.0);
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
      R"([{"role": "user", "content": "The sky is blue. What color is the sky?"}, {"role": "assistant", "content": "Blue."}, {"role": "user", "content": "What color did I say the sky was?"}])",
      cacheFile,
      false);

  // Clean up cache file.
  if (fs::exists(cacheFile)) {
    fs::remove(cacheFile);
  }

  EXPECT_FALSE(response2.empty())
      << "a reloaded cache must still yield a completion";
  EXPECT_GT(getStatValue(model->runtimeStats(), "CacheTokens"), 0.0)
      << "STALE CACHE RESIDENCY BUG: CacheManager believed the cache was "
         "resident in seq 0 even though the batch scheduler occupied and "
         "wiped seq 0.";
}

// GGSQ unification (sub-task 1): the single-prompt CacheManager path must write
// the per-sequence state format (GGSQ), not the whole-session format (GGSN), so
// the same on-disk cache can be read back by the batch per-sequence loader. A
// freshly written single-prompt cache file therefore starts with the GGSQ magic
// (0x67677371, 'ggsq'); today it starts with GGSN (0x6767736e) and this fails.
TEST_F(CacheManagementTest, SinglePromptCacheUsesSeqStateFormat) {
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
        R"([{"role": "user", "content": "What is ethereum? Answer shortly."}])",
        session1_path,
        true);
  });

  ASSERT_TRUE(fs::exists(session1_path));

  std::ifstream file(session1_path, std::ios::binary);
  ASSERT_TRUE(file.is_open());
  std::uint32_t magic = 0;
  file.read(reinterpret_cast<char*>(&magic), sizeof(magic));
  ASSERT_EQ(file.gcount(), static_cast<std::streamsize>(sizeof(magic)));

  EXPECT_EQ(magic, static_cast<std::uint32_t>(LLAMA_STATE_SEQ_MAGIC))
      << "single-prompt cache wrote magic 0x" << std::hex << magic
      << " (expected GGSQ 0x"
      << static_cast<std::uint32_t>(LLAMA_STATE_SEQ_MAGIC)
      << "); CacheManager still uses the whole-session GGSN format instead of "
         "the per-sequence GGSQ format shared with the batch path.";
}

namespace {

std::unique_ptr<LlamaModel> loadSlidingWindowModel(
    const test_common::TestModelPath& modelPath, const char* ctxSize = "4096") {
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = ctxSize;
  config["n_predict"] = "24";
  config["temp"] = "0";
  config["seed"] = "7";
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string path = modelPath.path;
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::string(), std::move(config));
  model->waitForLoadInitialization();
  return model;
}

std::string slidingWindowBrief(int editedFact) {
  std::string text = "Read this brief carefully. ";
  for (int i = 0; i < 220; ++i) {
    text +=
        i == editedFact
            ? "Fact " + std::to_string(i) + " was corrected: the lamp is red. "
            : "Fact " + std::to_string(i) + " says the harbor lamp stays " +
                  "lit until dawn. ";
  }
  return R"([{"role":"user","content":")" + text +
         R"( What colour is the lamp?"}])";
}

} // namespace

// Sliding-window layers keep only the last `n_swa` positions resident (the
// default `swa_full=false`). A cached turn that diverges far behind the KV
// head cannot be served by a tail trim: the window in front of the divergence
// was evicted, so the suffix would attend to a truncated window. It must be
// reprocessed, which makes it exactly the same computation as a cold run.
TEST(CacheSlidingWindowTest, DivergenceBehindTheWindowMatchesAColdRun) {
  const test_common::TestModelPath modelPath(
      "gemma-3-270m-it-Q8_0.gguf",
      "GEMMA3_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/ggml-org/gemma-3-270m-it-GGUF");
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  const fs::path cacheFile = "sliding_window_cache.bin";
  fs::remove(cacheFile);

  // ~2.5k tokens, so the 512-position window has evicted most of the prompt;
  // the edit lands near the middle, far behind the window.
  auto cached = loadSlidingWindowModel(modelPath);
  ASSERT_TRUE(cached->isLoaded());
  LlamaModel::Prompt primer;
  primer.input = slidingWindowBrief(-1);
  primer.prefill = true;
  primer.cacheKey = cacheFile.string();
  EXPECT_TRUE(cached->processPrompt(primer).empty());

  LlamaModel::Prompt edited;
  edited.input = slidingWindowBrief(110);
  edited.cacheKey = cacheFile.string();
  const std::string fromCache = cached->processPrompt(edited);

  auto cold = loadSlidingWindowModel(modelPath);
  ASSERT_TRUE(cold->isLoaded());
  LlamaModel::Prompt fresh;
  fresh.input = edited.input;
  const std::string fromScratch = cold->processPrompt(fresh);

  ASSERT_FALSE(fromScratch.empty());
  EXPECT_EQ(fromCache, fromScratch)
      << "a cached turn diverging behind the sliding window must be "
         "reprocessed, not trimmed onto an evicted window";

  fs::remove(cacheFile);
}

// A rollback trims back to the pre-request cursor, but a request that decoded
// more than a window past it has evicted the cells in front of that cursor.
// The cache must restart cold rather than keep a ledger that claims them.
TEST(CacheSlidingWindowTest, RollbackPastTheWindowRestartsCold) {
  const test_common::TestModelPath modelPath(
      "gemma-3-270m-it-Q8_0.gguf",
      "GEMMA3_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/ggml-org/gemma-3-270m-it-GGUF");
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  const fs::path cacheFile = "sliding_window_rollback_cache.bin";
  fs::remove(cacheFile);
  const std::string history =
      R"([{"role":"user","content":"Name one thing a harbor lamp needs."}])";

  // 2048 positions against a 512-position window: filling the context evicts
  // every window cell in front of the primed prompt.
  auto cached = loadSlidingWindowModel(modelPath, "2048");
  ASSERT_TRUE(cached->isLoaded());
  LlamaModel::Prompt primer;
  primer.input = history;
  primer.prefill = true;
  primer.cacheKey = cacheFile.string();
  EXPECT_TRUE(cached->processPrompt(primer).empty());

  // The grammar never completes, so the turn runs until the context is full
  // and the overflow rolls it back.
  LlamaModel::Prompt overflowing;
  overflowing.input = history;
  overflowing.cacheKey = cacheFile.string();
  overflowing.generationParams.grammar = R"(root ::= "lighthouse " root)";
  overflowing.generationParams.n_predict = -1;
  try {
    (void)cached->processPrompt(overflowing);
  } catch (const std::exception&) {
    // How the overflow surfaces does not matter; the state it leaves does.
  }

  LlmContext* context = LlamaModelTestPeer::llmContext(*cached);
  ASSERT_NE(context, nullptr);
  llama_context* lctx = context->getCtx();
  const int32_t nSwa = llama_model_n_swa(llama_get_model(lctx));
  ASSERT_GT(nSwa, 0);
  // A non-empty cursor needs its window resident; an emptied window reports
  // pos_min -1, which is as wrong as a truncated one.
  const llama_pos nPast = context->getNPast();
  if (nPast > 0) {
    const llama_pos posMin =
        llama_memory_seq_pos_min(llama_get_memory(lctx), context->getSeqId());
    EXPECT_GE(posMin, 0) << "the rollback left a cursor at " << nPast
                         << " with no sliding-window cells at all";
    EXPECT_LE(posMin, std::max<llama_pos>(0, nPast - nSwa))
        << "the rollback left a cursor at " << nPast
        << " whose sliding window is no longer resident";
  }

  LlamaModel::Prompt next;
  next.input = history;
  next.cacheKey = cacheFile.string();
  const std::string fromCache = cached->processPrompt(next);

  auto cold = loadSlidingWindowModel(modelPath, "2048");
  ASSERT_TRUE(cold->isLoaded());
  LlamaModel::Prompt fresh;
  fresh.input = history;
  const std::string fromScratch = cold->processPrompt(fresh);

  ASSERT_FALSE(fromScratch.empty());
  EXPECT_EQ(fromCache, fromScratch)
      << "the turn after a rollback past the window must match a cold run";

  cached.reset();
  fs::remove(cacheFile);
}

// The window check must not fire when nothing past the rollback target was
// decoded: a long history whose window cache has wrapped keeps its cursor.
TEST(CacheSlidingWindowTest, RollbackWithTheWindowIntactKeepsTheCache) {
  const test_common::TestModelPath modelPath(
      "gemma-3-270m-it-Q8_0.gguf",
      "GEMMA3_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/ggml-org/gemma-3-270m-it-GGUF");
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  const fs::path cacheFile = "sliding_window_intact_rollback_cache.bin";
  fs::remove(cacheFile);

  // ~2.5k tokens: past the window cache, so its oldest cells are reused.
  auto model = loadSlidingWindowModel(modelPath);
  ASSERT_TRUE(model->isLoaded());
  LlamaModel::Prompt primer;
  primer.input = slidingWindowBrief(-1);
  primer.prefill = true;
  primer.cacheKey = cacheFile.string();
  EXPECT_TRUE(model->processPrompt(primer).empty());

  LlmContext* context = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(context, nullptr);
  const llama_pos primed = context->getNPast();
  ASSERT_GT(primed, 1024);

  // Stopped before its first prefill batch, so the request rolls back having
  // decoded nothing past its target (one token short of the primer, re-decoded
  // for fresh logits).
  LlamaModel::Prompt stopped;
  stopped.input = primer.input;
  stopped.cacheKey = cacheFile.string();
  context->stop();
  try {
    (void)model->processPrompt(stopped);
  } catch (const std::exception&) {
    // How the cancel surfaces does not matter; the state it leaves does.
  }

  EXPECT_EQ(context->getNPast(), primed - 1)
      << "a rollback that decoded nothing past its target must keep the cache";

  model.reset();
  fs::remove(cacheFile);
}

namespace {

test_common::TestModelPath hybridModelPath() {
  return test_common::TestModelPath(
      "Qwen3.5-0.8B-Q8_0.gguf",
      "QWEN35_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF");
}

std::unique_ptr<LlamaModel> loadHybridChatModel(
    const test_common::TestModelPath& modelPath, const char* parallel,
    const char* checkpoints = nullptr, const char* storage = nullptr) {
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = "4096";
  config["n_predict"] = "48";
  config["temp"] = "0";
  config["seed"] = "11";
  if (parallel != nullptr) {
    config["parallel"] = parallel;
  }
  if (checkpoints != nullptr) {
    config["cache_checkpoints"] = checkpoints;
  }
  if (storage != nullptr) {
    config["cache_checkpoint_storage"] = storage;
  }
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string path = modelPath.path;
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::string(), std::move(config));
  model->waitForLoadInitialization();
  return model;
}

std::string
chatInput(const std::vector<std::pair<std::string, std::string>>& messages) {
  nlohmann::json array = nlohmann::json::array();
  for (const auto& [role, content] : messages) {
    array.push_back({{"role", role}, {"content", content}});
  }
  return array.dump();
}

bool mentions(std::string text, const std::string& word) {
  std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return text.find(word) != std::string::npos;
}

/// The last turn of a reused chat must still see the conversation: its
/// reasoning refers to the first turn's subject ("rainbow") or to a follow-up
/// ("warmest", "coolest"), which only make sense with the earlier turns. Its
/// text is not compared with a cold run: restoring a checkpoint splits the
/// prefill into other batch shapes, and greedy output drifts after a few tokens
/// on CUDA and Vulkan.
void expectAnswersFromTheWholeChat(const std::string& last) {
  EXPECT_TRUE(
      mentions(last, "rainbow") || mentions(last, "warm") ||
      mentions(last, "cool"))
      << "the last turn lost the conversation: " << last;
}

} // namespace

// Qwen3.5's template drops a previous answer's thinking from history, so the
// next turn diverges right after that answer's assistant header. Neither the
// pre-request state (it holds the raw answer) nor one at the end of the
// prompt (it holds the generation prompt) is a prefix of that turn; only the
// end-of-history checkpoint is. Without it every turn re-prefills the whole
// conversation on a hybrid model.
TEST(CacheHistoryCheckpointTest, HybridThinkingChatReusesTheHistory) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  auto model = loadHybridChatModel(modelPath, nullptr);
  ASSERT_TRUE(model->isLoaded());
  ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr);
  auto* text =
      dynamic_cast<TextLlmContext*>(LlamaModelTestPeer::llmContext(*model));
  ASSERT_NE(text, nullptr);

  const fs::path cacheFile = "history_checkpoint_cache.bin";
  fs::remove(cacheFile);
  const auto run = [&](const std::string& input) {
    LlamaModel::Prompt prompt;
    prompt.input = input;
    prompt.cacheKey = cacheFile.string();
    return model->processPrompt(prompt);
  };

  std::vector<std::pair<std::string, std::string>> chat = {
      {"user", "Name three colours of the rainbow."}};
  const std::string first = run(chatInput(chat));
  ASSERT_FALSE(first.empty());
  EXPECT_EQ(text->lastCacheReuseForTesting(), 0u);

  const std::vector<std::string> followUps = {
      "Which of them is warmest?", "And which is coolest?"};
  std::string last;
  size_t previousReuse = 0;
  chat.emplace_back("assistant", first);
  for (const std::string& followUp : followUps) {
    chat.emplace_back("user", followUp);
    last = run(chatInput(chat));
    ASSERT_FALSE(last.empty());
    EXPECT_GT(text->lastCacheReuseForTesting(), previousReuse)
        << "turn restored no end-of-history checkpoint and re-prefilled the "
           "whole conversation";
    previousReuse = text->lastCacheReuseForTesting();
    chat.emplace_back("assistant", last);
  }

  expectAnswersFromTheWholeChat(last);

  fs::remove(cacheFile);
}

namespace {

// DeepSeek V4 is too large for the unit-test model set; point
// `DSV4_MODEL_PATH` at a (first-shard) GGUF to run its checkpoint tests.
test_common::TestModelPath deepSeekV4ModelPath() {
  return test_common::TestModelPath(
      "DeepSeek-V4-Flash-0731-UD-IQ1_M-00001-of-00003.gguf",
      "DSV4_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF");
}

std::unique_ptr<LlamaModel> loadDeepSeekV4ChatModel(
    const test_common::TestModelPath& modelPath, const char* checkpoints) {
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = "4096";
  config["n_predict"] = "32";
  config["temp"] = "0";
  config["seed"] = "11";
  // Bigger than one GPU: spread the layers over every visible device.
  config["split_mode"] = "layer";
  if (checkpoints != nullptr) {
    config["cache_checkpoints"] = checkpoints;
  }
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string path = modelPath.path;
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::string(), std::move(config));
  model->waitForLoadInitialization();
  return model;
}

struct NextEditRegenerateRun {
  std::vector<size_t> reuse; ///< Per turn: next turn, edit, regenerate.
  std::string next;          ///< The ordinary next turn's answer.
};

// Turn 1, an ordinary next turn, an edit of that turn's user message, then a
// regenerate of the edited turn. Records each turn's prefix reuse.
NextEditRegenerateRun
runNextEditRegenerate(LlamaModel& model, const fs::path& key) {
  auto* text =
      dynamic_cast<TextLlmContext*>(LlamaModelTestPeer::llmContext(model));
  EXPECT_NE(text, nullptr);
  const auto run = [&](const std::string& input) {
    LlamaModel::Prompt prompt;
    prompt.input = input;
    prompt.cacheKey = key.string();
    return model.processPrompt(prompt);
  };
  NextEditRegenerateRun result;
  std::vector<std::pair<std::string, std::string>> chat = {
      {"user", "Name three colours of the rainbow."}};
  const std::string first = run(chatInput(chat));
  EXPECT_FALSE(first.empty());
  EXPECT_EQ(text->lastCacheReuseForTesting(), 0u);
  chat.emplace_back("assistant", first);
  chat.emplace_back("user", "Which of them is warmest?");
  result.next = run(chatInput(chat));
  result.reuse.push_back(text->lastCacheReuseForTesting());
  chat.back().second = "Which of them is coolest?";
  run(chatInput(chat));
  result.reuse.push_back(text->lastCacheReuseForTesting());
  run(chatInput(chat));
  result.reuse.push_back(text->lastCacheReuseForTesting());
  std::cerr << "[checkpoints] reuse next=" << result.reuse[0]
            << " edit=" << result.reuse[1] << " regenerate=" << result.reuse[2]
            << "\n";
  return result;
}

// Checks a model against `runNextEditRegenerate` with two checkpoints and
// with the default one. The last end-of-history checkpoint serves the
// next turn and the regenerate; the one before it serves the edit, which with
// a single checkpoint is a cold prefill. The previous answer's rewrite (both
// models drop the reasoning) is why the turn-old checkpoint, not the
// pre-request state, is the one an edit can restore.
void expectSecondCheckpointServesTheEdit(
    const NextEditRegenerateRun& two, const NextEditRegenerateRun& one) {
  ASSERT_EQ(two.reuse.size(), 3u);
  ASSERT_EQ(one.reuse.size(), 3u);
  EXPECT_GT(two.reuse[0], 0u) << "next turn restored no checkpoint";
  EXPECT_GT(two.reuse[1], 0u) << "edit restored no checkpoint";
  EXPECT_GT(two.reuse[2], 0u) << "regenerate restored no checkpoint";
  EXPECT_EQ(two.reuse[0], one.reuse[0]);
  EXPECT_EQ(two.next, one.next);
  EXPECT_EQ(one.reuse[1], 0u)
      << "one checkpoint: the edit diverges before the last one";
}

} // namespace

TEST(
    CacheHistoryCheckpointTest,
    HybridEditOfLastUserMessageRestoresTheTurnBefore) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  const fs::path cacheFile = "hybrid_edit_checkpoint_cache.bin";
  NextEditRegenerateRun two;
  NextEditRegenerateRun one;
  for (const char* checkpoints : {"2", static_cast<const char*>(nullptr)}) {
    fs::remove(cacheFile);
    auto model = loadHybridChatModel(modelPath, nullptr, checkpoints);
    ASSERT_TRUE(model->isLoaded());
    (checkpoints != nullptr ? two : one) =
        runNextEditRegenerate(*model, cacheFile);
  }
  fs::remove(cacheFile);
  expectSecondCheckpointServesTheEdit(two, one);
}

// Snapshots and checkpoints live in host RAM unless the config asks for temp
// files: the same chat writes none by default and some with `disk`.
TEST(CacheHistoryCheckpointTest, HybridCheckpointsStayInMemoryByDefault) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  const fs::path cacheFile = "hybrid_checkpoint_storage_cache.bin";
  for (const char* storage : {static_cast<const char*>(nullptr), "disk"}) {
    fs::remove(cacheFile);
    auto model = loadHybridChatModel(modelPath, nullptr, nullptr, storage);
    ASSERT_TRUE(model->isLoaded());
    const uint64_t filesBefore = qvac_lib_inference_addon_llama::utils::
        sequenceStateSnapshotFilesWritten();
    const NextEditRegenerateRun run = runNextEditRegenerate(*model, cacheFile);
    ASSERT_GT(run.reuse[0], 0u) << "the chat never restored a checkpoint";
    const uint64_t written = qvac_lib_inference_addon_llama::utils::
                                 sequenceStateSnapshotFilesWritten() -
                             filesBefore;
    if (storage == nullptr) {
      EXPECT_EQ(written, 0u) << "the default must keep snapshots in RAM";
    } else {
      EXPECT_GT(written, 0u) << "`disk` must write snapshots to temp files";
    }
  }
  fs::remove(cacheFile);
}

// `cache_checkpoint_dir` moves disk snapshots out of the OS temp dir (which an
// Android app cannot use) into a private directory under the given base.
TEST(CacheHistoryCheckpointTest, HybridDiskCheckpointsGoToTheCheckpointDir) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  const fs::path cacheFile = "hybrid_checkpoint_dir_cache.bin";
  const fs::path base = fs::temp_directory_path() / "qvac_checkpoint_dir_test";
  fs::remove(cacheFile);
  fs::remove_all(base);
  fs::create_directories(base);

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = "4096";
  config["n_predict"] = "48";
  config["temp"] = "0";
  config["seed"] = "11";
  config["cache_checkpoint_storage"] = "disk";
  config["cache_checkpoint_dir"] = base.string();
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string path = modelPath.path;
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::string(), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  const uint64_t filesBefore = qvac_lib_inference_addon_llama::utils::
      sequenceStateSnapshotFilesWritten();
  const NextEditRegenerateRun run = runNextEditRegenerate(*model, cacheFile);
  ASSERT_GT(run.reuse[0], 0u) << "the chat never restored a checkpoint";
  EXPECT_GT(
      qvac_lib_inference_addon_llama::utils::
              sequenceStateSnapshotFilesWritten() -
          filesBefore,
      0u);

  // The private directory sits under the base, and holds the live checkpoint
  // files; nothing is written into the base itself.
  std::vector<fs::path> entries;
  for (const auto& entry : fs::directory_iterator(base)) {
    entries.push_back(entry.path());
  }
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_TRUE(fs::is_directory(entries.front()));
  EXPECT_FALSE(fs::is_empty(entries.front()))
      << "the live checkpoints are not in the checkpoint dir";

  model.reset();
  fs::remove(cacheFile);
  fs::remove_all(base);
}

// Changing the user message k-th from the end needs k + 1 checkpoints: after
// three turns, an edit of the second user message (k = 2) restores the end of
// the first one with 3 and is a cold prefill with 2.
TEST(CacheHistoryCheckpointTest, HybridEditKTurnsBackNeedsKPlusOneCheckpoints) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  const fs::path cacheFile = "hybrid_edit_k_back_cache.bin";
  size_t reuseWithThree = 0;
  size_t reuseWithTwo = 0;
  for (const char* checkpoints : {"3", "2"}) {
    fs::remove(cacheFile);
    auto model = loadHybridChatModel(modelPath, nullptr, checkpoints);
    ASSERT_TRUE(model->isLoaded());
    auto* text =
        dynamic_cast<TextLlmContext*>(LlamaModelTestPeer::llmContext(*model));
    ASSERT_NE(text, nullptr);
    const auto run = [&](const std::string& input) {
      LlamaModel::Prompt prompt;
      prompt.input = input;
      prompt.cacheKey = cacheFile.string();
      return model->processPrompt(prompt);
    };
    std::vector<std::pair<std::string, std::string>> chat;
    for (const char* user :
         {"Name three colours of the rainbow.",
          "Which of them is warmest?",
          "And which is coolest?"}) {
      chat.emplace_back("user", user);
      chat.emplace_back("assistant", run(chatInput(chat)));
    }
    // Back to the second user message, changed.
    chat.resize(3);
    chat.back().second = "Which of them is the darkest?";
    run(chatInput(chat));
    (std::string(checkpoints) == "3" ? reuseWithThree : reuseWithTwo) =
        text->lastCacheReuseForTesting();
  }
  fs::remove(cacheFile);
  EXPECT_GT(reuseWithThree, 0u)
      << "3 checkpoints keep the end of the first user message";
  EXPECT_EQ(reuseWithTwo, 0u)
      << "2 checkpoints keep only the last two user messages' ends";
}

// The same on DeepSeek V4, whose partial checkpoints hold the sliding window
// and the compressor states.
TEST(CacheHistoryCheckpointTest, DeepSeekV4SecondCheckpointServesTheEdit) {
  const test_common::TestModelPath modelPath = deepSeekV4ModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  const fs::path cacheFile = "dsv4_history_checkpoint_cache.bin";
  fs::remove(cacheFile);

  NextEditRegenerateRun two;
  {
    auto model = loadDeepSeekV4ChatModel(modelPath, "2");
    ASSERT_TRUE(model->isLoaded());
    ASSERT_EQ(LlamaModelTestPeer::scheduler(*model), nullptr);
    two = runNextEditRegenerate(*model, cacheFile);
  }
  fs::remove(cacheFile);
  NextEditRegenerateRun one;
  {
    auto model = loadDeepSeekV4ChatModel(modelPath, nullptr);
    ASSERT_TRUE(model->isLoaded());
    EXPECT_EQ(LlamaModelTestPeer::checkpointPolicy(*model).maxCount, 1u);
    one = runNextEditRegenerate(*model, cacheFile);
  }
  fs::remove(cacheFile);
  expectSecondCheckpointServesTheEdit(two, one);
}

// The JSON parser hands the template an assistant turn's reasoning in
// `reasoning_content`: split out of an inline `content` on a model with a
// reasoning channel, or taken from the message's own field.
TEST(PromptParsingTest, AssistantReasoningMovesOutOfContent) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  auto model = loadHybridChatModel(modelPath, nullptr);
  ASSERT_TRUE(model->isLoaded());
  const ParsedPromptPayload parsed = LlamaModelTestPeer::formatPrompt(
      *model,
      R"([{"role":"user","content":"<think>mine</think>Hi"},)"
      R"({"role":"assistant","content":"<think>\nPlan.\n</think>\n\nHello."},)"
      R"({"role":"assistant","content":"Bye.","reasoning_content":"Given."},)"
      R"({"role":"user","content":"Again"}])");
  ASSERT_EQ(parsed.chatMsgs.size(), 4u);
  EXPECT_EQ(parsed.chatMsgs[0].content, "<think>mine</think>Hi");
  EXPECT_EQ(parsed.chatMsgs[1].reasoning_content, "Plan.");
  EXPECT_EQ(parsed.chatMsgs[1].content, "Hello.");
  EXPECT_EQ(parsed.chatMsgs[2].reasoning_content, "Given.");
  EXPECT_EQ(parsed.chatMsgs[2].content, "Bye.");
}

// A model without a reasoning channel keeps assistant text as it came.
TEST(PromptParsingTest, ModelWithoutReasoningChannelKeepsContent) {
  const std::string path =
      test_common::BaseTestModelPath::get("Llama-3.2-1B-Instruct-Q4_0.gguf");
  if (!fs::exists(path)) {
    GTEST_SKIP() << "Llama-3.2-1B-Instruct-Q4_0.gguf not found";
  }
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = "2048";
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string modelPath = path;
  auto model = std::make_unique<LlamaModel>(
      std::move(modelPath), std::string(), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());
  const ParsedPromptPayload parsed = LlamaModelTestPeer::formatPrompt(
      *model,
      R"([{"role":"user","content":"Hi"},)"
      R"({"role":"assistant","content":"<think>x</think>Hello."}])");
  ASSERT_EQ(parsed.chatMsgs.size(), 2u);
  EXPECT_EQ(parsed.chatMsgs[1].content, "<think>x</think>Hello.");
  EXPECT_TRUE(parsed.chatMsgs[1].reasoning_content.empty());
}

// A prompt that is fully cached is re-decoded for its last token only, to get
// fresh logits. llama books a one-token decode as generation, so stats read
// from its perf counters reported no prompt work (TTFT 0, ppTPS 0). The
// addon counts and times its own prefill.
TEST(CacheRuntimeStatsTest, FullyCachedPromptReportsItsPromptWork) {
  const std::string path =
      test_common::BaseTestModelPath::get("Qwen3-0.6B-Q8_0.gguf");
  if (!fs::exists(path)) {
    GTEST_SKIP() << "Qwen3-0.6B-Q8_0.gguf not found";
  }
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = "2048";
  config["n_predict"] = "8";
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string modelPath = path;
  auto model = std::make_unique<LlamaModel>(
      std::move(modelPath), std::string(), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  const fs::path cacheFile = "fully_cached_prompt_stats.bin";
  fs::remove(cacheFile);
  const std::string input =
      R"([{"role":"user","content":"Name one colour of the rainbow."}])";
  LlamaModel::Prompt warm;
  warm.input = input;
  warm.cacheKey = cacheFile.string();
  warm.prefill = true;
  ASSERT_NO_THROW((void)model->processPrompt(warm));

  LlamaModel::Prompt repeat;
  repeat.input = input;
  repeat.cacheKey = cacheFile.string();
  ASSERT_NO_THROW((void)model->processPrompt(repeat));
  const auto stats = model->runtimeStats();
  EXPECT_EQ(test_common::getStatValue(stats, "promptTokens"), 1.0)
      << "only the last prompt token is re-decoded";
  EXPECT_GT(test_common::getStatValue(stats, "TTFT"), 0.0);
  EXPECT_GT(test_common::getStatValue(stats, "ppTPS"), 0.0);
  EXPECT_GT(test_common::getStatValue(stats, "generatedTokens"), 0.0);
  EXPECT_GT(test_common::getStatValue(stats, "TPS"), 0.0);
  fs::remove(cacheFile);
}

// Batch mode gives every request a fresh slot driver, so the checkpoints
// must outlive it in the scheduler to reach the next turn on the same
// cacheKey. The prefill stops at the end of the history for the capture.
TEST(CacheHistoryCheckpointTest, BatchedHybridThinkingChatReusesTheHistory) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  auto model = loadHybridChatModel(modelPath, "2");
  ASSERT_TRUE(model->isLoaded());
  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr);

  TextLlmContext* driver = nullptr;
  const auto original =
      ContinuousBatchSchedulerTestPeer::driverFactory(*scheduler);
  ContinuousBatchSchedulerTestPeer::setDriverFactory(
      *scheduler,
      [original, &driver](
          const common_params& params, uint32_t seqId, llama_pos ceiling) {
        std::unique_ptr<SequenceDriver> built =
            original(params, seqId, ceiling);
        driver = dynamic_cast<TextLlmContext*>(built.get());
        return built;
      });

  const fs::path cacheFile = "batched_history_checkpoint_cache.bin";
  fs::remove(cacheFile);
  // Read while the request's driver is alive: it is freed with its slot.
  size_t reuse = 0;
  const auto run = [&](const std::string& input) {
    LlamaModel::Prompt prompt;
    prompt.input = input;
    prompt.cacheKey = cacheFile.string();
    bool read = false;
    prompt.outputCallback = [&](const std::string&) {
      if (!read && driver != nullptr) {
        reuse = driver->lastCacheReuseForTesting();
        read = true;
      }
    };
    const auto outputs = model->processPromptBatch({prompt});
    return outputs.empty() ? std::string() : outputs.front();
  };

  std::vector<std::pair<std::string, std::string>> chat = {
      {"user", "Name three colours of the rainbow."}};
  const std::string first = run(chatInput(chat));
  ASSERT_FALSE(first.empty());
  EXPECT_EQ(reuse, 0u);

  std::string last;
  size_t previousReuse = 0;
  chat.emplace_back("assistant", first);
  for (const char* followUp :
       {"Which of them is warmest?", "And which is coolest?"}) {
    chat.emplace_back("user", followUp);
    last = run(chatInput(chat));
    ASSERT_FALSE(last.empty());
    EXPECT_GT(reuse, previousReuse)
        << "batched turn restored no end-of-history checkpoint";
    previousReuse = reuse;
    chat.emplace_back("assistant", last);
  }

  expectAnswersFromTheWholeChat(last);

  fs::remove(cacheFile);
}

namespace {

std::unique_ptr<LlamaModel>
loadBatchedModel(const char* cacheRamMib = nullptr) {
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = "4096";
  config["parallel"] = "2";
  config["n_predict"] = "16";
  config["temp"] = "0";
  config["seed"] = "5";
  if (cacheRamMib != nullptr) {
    config["cache_ram_mib"] = cacheRamMib;
  }
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string path = test_common::BaseTestModelPath::get();
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::string(), std::move(config));
  model->waitForLoadInitialization();
  return model;
}

// Runs one keyed batch request and returns its output plus the prompt
// entries its driver reused (read while the driver is alive).
struct BatchedTurn {
  std::string output;
  size_t reuse = 0;
};

class BatchedCacheHarness {
public:
  explicit BatchedCacheHarness(LlamaModel& model)
      : model_(model), scheduler_(LlamaModelTestPeer::scheduler(model)) {
    const auto original =
        ContinuousBatchSchedulerTestPeer::driverFactory(*scheduler_);
    ContinuousBatchSchedulerTestPeer::setDriverFactory(
        *scheduler_,
        [original,
         this](const common_params& params, uint32_t seqId, llama_pos ceiling) {
          std::unique_ptr<SequenceDriver> built =
              original(params, seqId, ceiling);
          driver_ = dynamic_cast<TextLlmContext*>(built.get());
          return built;
        });
  }

  BatchedTurn
  run(const std::string& input, const std::string& cacheKey,
      bool saveAfter = false) {
    BatchedTurn turn;
    LlamaModel::Prompt prompt;
    prompt.input = input;
    prompt.cacheKey = cacheKey;
    bool read = false;
    prompt.outputCallback = [&](const std::string&) {
      if (!read && driver_ != nullptr) {
        turn.reuse = driver_->lastCacheReuseForTesting();
        read = true;
      }
    };
    const auto outputs = model_.processPromptBatch({prompt});
    turn.output = outputs.empty() ? std::string() : outputs.front();
    if (saveAfter) {
      model_.saveCache(cacheKey);
    }
    return turn;
  }

  qvac_lib_inference_addon_llama::batching::ContinuousBatchScheduler&
  scheduler() {
    return *scheduler_;
  }

private:
  LlamaModel& model_;
  qvac_lib_inference_addon_llama::batching::ContinuousBatchScheduler*
      scheduler_;
  TextLlmContext* driver_ = nullptr;
};

std::string userTurns(const std::vector<std::string>& turns) {
  std::vector<std::pair<std::string, std::string>> chat;
  for (size_t i = 0; i < turns.size(); ++i) {
    chat.emplace_back(i % 2 == 0 ? "user" : "assistant", turns[i]);
  }
  return chatInput(chat);
}

} // namespace

// The batch path used to wipe the slot after every
// request, so a follow-up re-prefilled the whole conversation. The committed
// state now stays parked in its sequence for the next request on its key.
TEST(BatchedCacheResidencyTest, FollowUpReusesTheParkedSlotWithoutAFile) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  BatchedCacheHarness harness(*model);
  const std::string key = "resident_batch_cache.bin";
  fs::remove(key);

  const BatchedTurn first =
      harness.run(userTurns({"Name a colour of the sky."}), key);
  ASSERT_FALSE(first.output.empty());
  EXPECT_EQ(harness.scheduler().parkedSeqIds().size(), 1u);

  const BatchedTurn second = harness.run(
      userTurns({"Name a colour of the sky.", first.output, "And of grass?"}),
      key);
  ASSERT_FALSE(second.output.empty());
  EXPECT_GT(second.reuse, 0u) << "the follow-up re-prefilled the conversation";
  EXPECT_EQ(harness.scheduler().residentHitsForTesting(), 1u);
  EXPECT_FALSE(fs::exists(key)) << "nothing asked for the file to be written";
}

// With every sequence parked, a request on a new key evicts the least
// recently used conversation. Its unsaved turns are written to its cacheKey
// file first, so its next request loads them instead of starting cold.
TEST(BatchedCacheResidencyTest, EvictionWritesUnsavedTurnsToTheCacheFile) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  BatchedCacheHarness harness(*model);
  const std::vector<std::string> keys = {
      "evict_a.bin", "evict_b.bin", "evict_c.bin"};
  for (const auto& key : keys) {
    fs::remove(key);
  }

  const BatchedTurn a =
      harness.run(userTurns({"Say one word: apple."}), keys[0]);
  harness.run(userTurns({"Say one word: banana."}), keys[1]);
  EXPECT_FALSE(fs::exists(keys[0]));
  harness.run(userTurns({"Say one word: cherry."}), keys[2]);
  EXPECT_TRUE(fs::exists(keys[0])) << "evicted unsaved turns were not saved";
  EXPECT_FALSE(fs::exists(keys[1]))
      << "only the least recently used is evicted";

  const BatchedTurn followUp = harness.run(
      userTurns({"Say one word: apple.", a.output, "Again."}), keys[0]);
  EXPECT_GT(followUp.reuse, 0u) << "the evicted conversation was not reloaded";
  EXPECT_EQ(harness.scheduler().ramTierHitsForTesting(), 0u);

  for (const auto& key : keys) {
    fs::remove(key);
  }
}

// With `cache_ram_mib`, an evicted conversation is also copied to the RAM
// tier and its next request restores it from there. A budget too small for
// one state leaves it on disk only.
TEST(BatchedCacheResidencyTest, RamTierRestoresAnEvictedConversation) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  for (const auto& [budget, expectRamHit] :
       std::vector<std::pair<const char*, bool>>{{"512", true}, {"1", false}}) {
    auto model = loadBatchedModel(budget);
    ASSERT_TRUE(model->isLoaded());
    BatchedCacheHarness harness(*model);
    const std::vector<std::string> keys = {
        "ram_a.bin", "ram_b.bin", "ram_c.bin"};
    for (const auto& key : keys) {
      fs::remove(key);
    }
    std::string history;
    for (int i = 0; i < 30; ++i) {
      history += "Remember fact " + std::to_string(i) + ". ";
    }
    const BatchedTurn a =
        harness.run(userTurns({history + "Say apple."}), keys[0]);
    harness.run(userTurns({"Say banana."}), keys[1]);
    harness.run(userTurns({"Say cherry."}), keys[2]);

    const BatchedTurn followUp = harness.run(
        userTurns({history + "Say apple.", a.output, "Again."}), keys[0]);
    EXPECT_GT(followUp.reuse, 0u) << "budget " << budget;
    EXPECT_EQ(
        harness.scheduler().ramTierHitsForTesting(), expectRamHit ? 1u : 0u)
        << "budget " << budget << " MiB";
    // Unload first: with the tier on it writes unsaved turns out.
    model.reset();
    for (const auto& key : keys) {
      fs::remove(key);
    }
  }
}

// Requests without a cacheKey have nothing to be found by, so they are never
// parked.
TEST(BatchedCacheResidencyTest, KeylessRequestsAreNotParked) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  BatchedCacheHarness harness(*model);
  harness.run(userTurns({"Say hello."}), "");
  EXPECT_TRUE(harness.scheduler().parkedSeqIds().empty());
  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);
  EXPECT_EQ(llama_memory_seq_pos_max(mem, 0), -1);
  EXPECT_EQ(llama_memory_seq_pos_max(mem, 1), -1);
}

// Deleting the file a parked conversation was loaded from drops the
// conversation, like the single-prompt path does for its active session.
TEST(BatchedCacheResidencyTest, DeletedBackingFileDropsTheParkedState) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  BatchedCacheHarness harness(*model);
  const std::string key = "dropped_batch_cache.bin";
  fs::remove(key);

  const BatchedTurn first =
      harness.run(userTurns({"Name a fruit."}), key, /*saveAfter=*/true);
  ASSERT_TRUE(fs::exists(key));
  fs::remove(key);

  const BatchedTurn second =
      harness.run(userTurns({"Name a fruit.", first.output, "Another."}), key);
  EXPECT_EQ(second.reuse, 0u);
  EXPECT_EQ(harness.scheduler().residentHitsForTesting(), 0u);
  fs::remove(key);
}

// Two prompts on one cacheKey in the same batch run one after the other, so
// the second continues from what the first committed instead of forking it.
TEST(BatchedCacheResidencyTest, SameKeyPromptsRunInOrder) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  BatchedCacheHarness harness(*model);
  const std::string key = "same_key_batch_cache.bin";
  fs::remove(key);

  LlamaModel::Prompt prompt;
  prompt.input = userTurns({"Name a planet."});
  prompt.cacheKey = key;
  const auto outputs = model->processPromptBatch({prompt, prompt});
  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_FALSE(outputs[1].empty());
  EXPECT_EQ(harness.scheduler().residentHitsForTesting(), 1u)
      << "the second prompt did not start from the first one's state";
  fs::remove(key);
}

namespace {

std::unique_ptr<LlamaModel> loadSinglePromptModel(const char* cacheRamMib) {
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = "2048";
  config["n_predict"] = "12";
  config["temp"] = "0";
  config["seed"] = "5";
  if (cacheRamMib != nullptr) {
    config["cache_ram_mib"] = cacheRamMib;
  }
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string path = test_common::BaseTestModelPath::get();
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::string(), std::move(config));
  model->waitForLoadInitialization();
  return model;
}

struct SingleTurn {
  std::string output;
  size_t reuse = 0;
};

SingleTurn
runSingle(LlamaModel& model, const std::string& input, const std::string& key) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  prompt.cacheKey = key;
  SingleTurn turn;
  turn.output = model.processPrompt(prompt);
  if (auto* text = dynamic_cast<TextLlmContext*>(
          LlamaModelTestPeer::llmContext(model))) {
    turn.reuse = text->lastCacheReuseForTesting();
  }
  return turn;
}

} // namespace

// With `cache_ram_mib`, switching the single-prompt path between chats moves
// the outgoing one to host RAM instead of writing its file, and switching
// back restores it from there. Unsaved turns reach the files when the model
// is unloaded.
TEST(SinglePromptRamTierTest, KeySwitchesStayOffDiskUntilUnload) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  const std::string a = "single_ram_a.bin";
  const std::string b = "single_ram_b.bin";
  fs::remove(a);
  fs::remove(b);
  std::string firstA;
  {
    auto model = loadSinglePromptModel("512");
    ASSERT_TRUE(model->isLoaded());
    firstA = runSingle(*model, userTurns({"Say one word: apple."}), a).output;
    runSingle(*model, userTurns({"Say one word: banana."}), b);
    EXPECT_FALSE(fs::exists(a)) << "the switch wrote the file instead of RAM";

    const SingleTurn back = runSingle(
        *model, userTurns({"Say one word: apple.", firstA, "Again."}), a);
    EXPECT_GT(back.reuse, 0u) << "switching back did not restore from RAM";
    EXPECT_FALSE(fs::exists(a));
    EXPECT_FALSE(fs::exists(b));
  }
  EXPECT_TRUE(fs::exists(a)) << "unload did not flush the active chat";
  EXPECT_TRUE(fs::exists(b)) << "unload did not flush the RAM tier";

  // The flushed files are ordinary cache files.
  auto model = loadSinglePromptModel(nullptr);
  ASSERT_TRUE(model->isLoaded());
  const SingleTurn reloaded =
      runSingle(*model, userTurns({"Say one word: banana.", "x", "Again."}), b);
  EXPECT_GT(reloaded.reuse, 0u);
  model.reset();
  fs::remove(a);
  fs::remove(b);
}

// Without the tier the old behaviour stays: a key switch writes the file.
TEST(SinglePromptRamTierTest, WithoutTheTierAKeySwitchWritesTheFile) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  const std::string a = "single_noram_a.bin";
  fs::remove(a);
  auto model = loadSinglePromptModel(nullptr);
  ASSERT_TRUE(model->isLoaded());
  runSingle(*model, userTurns({"Say one word: apple."}), a);
  runSingle(*model, userTurns({"Say one word: banana."}), "single_noram_b.bin");
  EXPECT_TRUE(fs::exists(a));
  model.reset();
  fs::remove(a);
  fs::remove("single_noram_b.bin");
}

// A full budget pushes the oldest conversation out of RAM; its unsaved turns
// are written to its file first, so it is never lost.
TEST(SinglePromptRamTierTest, AFullBudgetWritesTheDroppedChatToItsFile) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  const std::vector<std::string> keys = {
      "full_ram_a.bin", "full_ram_b.bin", "full_ram_c.bin"};
  const auto removeKeys = [&] {
    for (const auto& key : keys) {
      fs::remove(key);
    }
  };
  // Long enough that one state spans a few MiB, so the budget can be sized
  // for exactly one of them.
  std::string filler;
  for (int i = 0; i < 80; ++i) {
    filler += "Note " + std::to_string(i) + " is kept. ";
  }
  const auto chat = [&](const char* word) {
    return userTurns({filler + "Say one word: " + word + "."});
  };

  // Measure one stored conversation, then size the budget for one, not two.
  removeKeys();
  uint64_t oneEntry = 0;
  {
    auto probe = loadSinglePromptModel("512");
    ASSERT_TRUE(probe->isLoaded());
    runSingle(*probe, chat("apple"), keys[0]);
    runSingle(*probe, chat("banana"), keys[1]);
    ASSERT_EQ(LlamaModelTestPeer::ramTier(*probe)->size(), 1u);
    oneEntry = LlamaModelTestPeer::ramTier(*probe)->totalBytes();
  }
  removeKeys();
  const uint64_t mib = 1024ULL * 1024ULL;
  const std::string budget = std::to_string((oneEntry * 3 / 2 + mib - 1) / mib);
  ASSERT_LT((oneEntry * 3 / 2 + mib - 1) / mib * mib, oneEntry * 2)
      << "entries too small to separate one from two at MiB granularity";

  auto model = loadSinglePromptModel(budget.c_str());
  ASSERT_TRUE(model->isLoaded());
  runSingle(*model, chat("apple"), keys[0]);
  runSingle(*model, chat("banana"), keys[1]);
  EXPECT_FALSE(fs::exists(keys[0]));
  runSingle(*model, chat("cherry"), keys[2]);
  EXPECT_TRUE(fs::exists(keys[0])) << "the dropped chat was not written";
  EXPECT_FALSE(fs::exists(keys[1])) << "the newer chat should still be in RAM";
  model.reset();
  removeKeys();
}

// Batch counterpart: with the tier on, an evicted conversation keeps its
// unsaved turns in RAM instead of writing its file; unload writes them.
TEST(BatchedCacheResidencyTest, RamTierDefersTheFileUntilUnload) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  const std::vector<std::string> keys = {
      "defer_a.bin", "defer_b.bin", "defer_c.bin"};
  for (const auto& key : keys) {
    fs::remove(key);
  }
  {
    auto model = loadBatchedModel("512");
    ASSERT_TRUE(model->isLoaded());
    BatchedCacheHarness harness(*model);
    const BatchedTurn a =
        harness.run(userTurns({"Say one word: apple."}), keys[0]);
    harness.run(userTurns({"Say one word: banana."}), keys[1]);
    harness.run(userTurns({"Say one word: cherry."}), keys[2]);
    EXPECT_FALSE(fs::exists(keys[0])) << "the eviction wrote through";
    const BatchedTurn back = harness.run(
        userTurns({"Say one word: apple.", a.output, "Again."}), keys[0]);
    EXPECT_GT(back.reuse, 0u);
    EXPECT_EQ(harness.scheduler().ramTierHitsForTesting(), 1u);
    for (const auto& key : keys) {
      EXPECT_FALSE(fs::exists(key)) << key;
    }
  }
  for (const auto& key : keys) {
    EXPECT_TRUE(fs::exists(key)) << key << " was not flushed at unload";
    fs::remove(key);
  }
}

// Finetuning reloads the model before training (and training clears every
// sequence). The reload must first write a parked batch conversation's
// unsaved turns to its file, so nothing kept in memory is lost.
TEST(BatchedCacheResidencyTest, ReloadWritesParkedConversationsToTheirFiles) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  const std::string key = "reload_parked.bin";
  fs::remove(key);
  {
    BatchedCacheHarness harness(*model);
    harness.run(userTurns({"Say one word: apple."}), key);
    ASSERT_EQ(harness.scheduler().parkedSeqIds().size(), 1u);
    ASSERT_FALSE(fs::exists(key));
  }
  model->reload();
  model->waitForLoadInitialization();
  EXPECT_TRUE(fs::exists(key)) << "the reload dropped the parked conversation";
  model.reset();
  fs::remove(key);
}

// ---------------------------------------------------------------------------
// Explicit saveCache, ephemeral conversations, and the unload flush.
// ---------------------------------------------------------------------------

namespace {

LlamaModel::Prompt keyedPrompt(
    const std::string& input, const std::string& key, bool ephemeral = false) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  prompt.cacheKey = key;
  prompt.ephemeral = ephemeral;
  return prompt;
}

} // namespace

// A clean unload writes a conversation's unsaved turns, with or without the
// RAM tier, so only a crash loses what was only in memory.
TEST(ExplicitSaveTest, UnloadWritesUnsavedTurnsWithoutTheRamTier) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  const std::string key = "unload_flush_single.bin";
  fs::remove(key);
  {
    auto model = loadSinglePromptModel(nullptr);
    ASSERT_TRUE(model->isLoaded());
    runSingle(*model, userTurns({"Say one word: apple."}), key);
    EXPECT_FALSE(fs::exists(key)) << "nothing asked for the file yet";
  }
  EXPECT_TRUE(fs::exists(key)) << "the unload dropped the unsaved turns";
  fs::remove(key);
}

// `saveCache` writes the active conversation, is a no-op when its file is
// current, and refuses a key nothing is cached under.
TEST(ExplicitSaveTest, SinglePromptSaveCacheWritesOnlyWhatIsUnsaved) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  const std::string key = "explicit_save_single.bin";
  const std::string unknown = "explicit_save_unknown.bin";
  fs::remove(key);
  fs::remove(unknown);
  auto model = loadSinglePromptModel(nullptr);
  ASSERT_TRUE(model->isLoaded());

  EXPECT_THROW(model->saveCache(unknown), qvac_errors::StatusError);
  EXPECT_THROW(model->saveCache(""), qvac_errors::StatusError);

  runSingle(*model, userTurns({"Say one word: apple."}), key);
  ASSERT_NO_THROW(model->saveCache(key));
  ASSERT_TRUE(fs::exists(key));
  const auto written = fs::last_write_time(key);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  ASSERT_NO_THROW(model->saveCache(key));
  EXPECT_TRUE(fs::last_write_time(key) == written)
      << "a conversation with no unsaved turns was written again";

  // Only on disk now (another key is active): still a no-op, not an error.
  runSingle(*model, userTurns({"Say one word: pear."}), unknown);
  EXPECT_NO_THROW(model->saveCache(key));
  model.reset();
  fs::remove(key);
  fs::remove(unknown);
}

// An ephemeral conversation is never written automatically: a key switch
// drops it and an unload does not write it, but an explicit save still does.
TEST(ExplicitSaveTest, SinglePromptEphemeralConversationIsNeverWritten) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  const std::string a = "ephemeral_single_a.bin";
  const std::string b = "ephemeral_single_b.bin";
  for (const auto& key : {a, b}) {
    fs::remove(key);
  }
  {
    auto model = loadSinglePromptModel(nullptr);
    ASSERT_TRUE(model->isLoaded());
    const std::string first = userTurns({"Say one word: apple."});
    ASSERT_FALSE(model->processPrompt(keyedPrompt(first, a, true)).empty());
    ASSERT_FALSE(model->processPrompt(keyedPrompt(first, b, true)).empty());
    EXPECT_FALSE(fs::exists(a)) << "the key switch wrote an ephemeral chat";

    // Switching back starts cold: the ephemeral chat was dropped.
    const SingleTurn back = runSingle(*model, first, a);
    EXPECT_EQ(back.reuse, 0u);

    // b stays active and ephemeral; an explicit save still writes it.
    ASSERT_FALSE(model->processPrompt(keyedPrompt(first, b, true)).empty());
    ASSERT_NO_THROW(model->saveCache(b));
    EXPECT_TRUE(fs::exists(b));
    fs::remove(b);
    ASSERT_FALSE(model->processPrompt(keyedPrompt(first, b, true)).empty());
  }
  EXPECT_FALSE(fs::exists(b)) << "the unload wrote an ephemeral chat";
  for (const auto& key : {a, b}) {
    fs::remove(key);
  }
}

// On the batch path `saveCache` writes the parked conversation, and a second
// call is a no-op.
TEST(ExplicitSaveTest, BatchSaveCacheWritesTheParkedConversation) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  BatchedCacheHarness harness(*model);
  const std::string key = "explicit_save_batch.bin";
  fs::remove(key);

  const BatchedTurn first = harness.run(userTurns({"Name a fruit."}), key);
  ASSERT_EQ(harness.scheduler().parkedSeqIds().size(), 1u);
  ASSERT_NO_THROW(model->saveCache(key));
  ASSERT_TRUE(fs::exists(key));
  const auto written = fs::last_write_time(key);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  ASSERT_NO_THROW(model->saveCache(key));
  EXPECT_TRUE(fs::last_write_time(key) == written)
      << "a parked conversation with no unsaved turns was written again";

  // The written file loads on another model and continues the chat.
  auto other = loadBatchedModel();
  BatchedCacheHarness otherHarness(*other);
  const BatchedTurn followUp = otherHarness.run(
      userTurns({"Name a fruit.", first.output, "Another one."}), key);
  EXPECT_GT(followUp.reuse, 0u);
  other.reset();
  model.reset();
  fs::remove(key);
}

// `saveCache` on a key whose request is still running waits for it to end
// and writes what it committed.
TEST(ExplicitSaveTest, BatchSaveCacheWaitsForTheRunningRequest) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  const std::string key = "explicit_save_waits.bin";
  fs::remove(key);

  std::atomic<bool> streaming{false};
  std::atomic<int64_t> lastTokenNs{0};
  LlamaModel::Prompt prompt =
      keyedPrompt(userTurns({"Count from one to twenty."}), key);
  prompt.outputCallback = [&](const std::string&) {
    streaming.store(true);
    lastTokenNs.store(
        std::chrono::steady_clock::now().time_since_epoch().count());
  };
  auto run = std::async(
      std::launch::async, [&] { return model->processPromptBatch({prompt}); });
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(60);
  while (!streaming.load() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(streaming.load()) << "the request never streamed";
  ASSERT_NO_THROW(model->saveCache(key));
  const int64_t savedNs =
      std::chrono::steady_clock::now().time_since_epoch().count();
  EXPECT_LE(lastTokenNs.load(), savedNs)
      << "saveCache returned before the request's last token";
  ASSERT_EQ(run.wait_for(std::chrono::seconds(60)), std::future_status::ready);
  EXPECT_FALSE(run.get().front().empty());
  EXPECT_TRUE(fs::exists(key));
  model.reset();
  fs::remove(key);
}

// A discard queued behind a running request on its key runs as soon as that
// request ends, before the next request on the key is admitted, so the next
// request starts cold instead of continuing the discarded conversation.
TEST(ExplicitSaveTest, BatchDiscardGoesBeforeTheNextRequestOnItsKey) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  // Holds the running request inside a decode step (the scheduler lock is
  // released there) until the discard and the next request are both queued.
  // Declared before the model, which installs it, so it outlives the worker.
  std::mutex gateMtx;
  std::condition_variable gateCv;
  bool hold = false;
  bool held = false;
  auto model = loadBatchedModel();
  ASSERT_TRUE(model->isLoaded());
  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr);
  const std::string key = "explicit_discard_order.bin";
  fs::remove(key);
  const std::string history = userTurns({"Name a fruit."});

  ASSERT_EQ(model->processPromptBatch({keyedPrompt(history, key)}).size(), 1u);
  ASSERT_EQ(scheduler->parkedSeqIds().size(), 1u);

  ContinuousBatchSchedulerTestPeer::setDecodeFunc(
      *scheduler, [&](llama_context* ctx, llama_batch& batch) {
        std::unique_lock lock(gateMtx);
        if (hold) {
          held = true;
          gateCv.notify_all();
          gateCv.wait(lock, [&] { return !hold; });
        }
        lock.unlock();
        return llama_decode(ctx, batch);
      });

  // Destroyed in reverse: the gate opens first, then the futures wait.
  std::future<std::vector<std::string>> runningDone;
  std::future<void> discarded;
  std::future<std::vector<std::string>> nextDone;
  struct OpenGateOnExit {
    std::mutex& mtx;
    std::condition_variable& cv;
    bool& hold;
    ~OpenGateOnExit() {
      {
        std::scoped_lock lock(mtx);
        hold = false;
      }
      cv.notify_all();
    }
  } openGateOnExit{gateMtx, gateCv, hold};
  const auto waitFor = [](const std::function<bool()>& ready) {
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(60);
    while (!ready() && std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return ready();
  };

  std::atomic<bool> streaming{false};
  LlamaModel::Prompt running = keyedPrompt(history, key);
  running.generationParams.grammar = R"(root ::= "lighthouse " root)";
  running.generationParams.n_predict = 64;
  running.outputCallback = [&](const std::string&) { streaming.store(true); };
  runningDone = std::async(
      std::launch::async, [&] { return model->processPromptBatch({running}); });
  ASSERT_TRUE(waitFor([&] { return streaming.load(); }))
      << "the running request never streamed";
  {
    std::unique_lock lock(gateMtx);
    hold = true;
    ASSERT_TRUE(gateCv.wait_for(lock, std::chrono::seconds(60), [&] {
      return held;
    })) << "the running request never reached its next decode";
  }

  discarded = std::async(std::launch::async, [&] { model->discardCache(key); });
  ASSERT_TRUE(waitFor([&] {
    return ContinuousBatchSchedulerTestPeer::queuedSaveJobs(*scheduler) == 1;
  })) << "the discard was never queued";
  const uint64_t hitsBefore = scheduler->residentHitsForTesting();
  nextDone = std::async(std::launch::async, [&] {
    return model->processPromptBatch({keyedPrompt(history, key)});
  });
  ASSERT_TRUE(waitFor([&] {
    return ContinuousBatchSchedulerTestPeer::queuedRequests(*scheduler) == 1;
  })) << "the next request was never queued";
  {
    std::scoped_lock lock(gateMtx);
    hold = false;
  }
  gateCv.notify_all();

  ASSERT_EQ(
      runningDone.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  ASSERT_EQ(
      discarded.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  ASSERT_EQ(
      nextDone.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  EXPECT_NO_THROW(discarded.get());
  EXPECT_FALSE(nextDone.get().front().empty());
  EXPECT_EQ(scheduler->residentHitsForTesting(), hitsBefore)
      << "the next request continued the conversation the caller discarded";
  model.reset();
  fs::remove(key);
}

// A rollback that lands on an empty sequence (here: a hybrid model edits the
// history past every checkpoint, then overflows) leaves nothing committed in
// memory. An explicit save must then leave the file holding the last commit
// alone instead of writing the empty state over it.
TEST(ExplicitSaveTest, SinglePromptSaveAfterAColdRollbackKeepsTheFile) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  // Small, so the endless grammar below fills it quickly.
  config["ctx_size"] = "512";
  config["n_predict"] = "24";
  config["temp"] = "0";
  config["seed"] = "11";
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string path = modelPath.path;
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::string(), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());
  const std::string key = "explicit_save_cold_rollback.bin";
  fs::remove(key);
  const auto readBytes = [](const std::string& file) {
    std::ifstream in(file, std::ios::binary);
    return std::string(
        std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  };

  (void)runSingle(
      *model, userTurns({"Name one thing a harbor lamp needs."}), key);
  ASSERT_NO_THROW(model->saveCache(key));
  const std::string saved = readBytes(key);
  ASSERT_FALSE(saved.empty());

  // Diverges inside the first message, so no checkpoint is a prefix and the
  // request starts cold; the grammar never completes, so it overflows and
  // rolls back to that empty start.
  LlamaModel::Prompt edited = keyedPrompt(
      userTurns({"Name one thing a lighthouse keeper needs."}), key);
  edited.generationParams.grammar = R"(root ::= "lighthouse " root)";
  edited.generationParams.n_predict = -1;
  try {
    (void)model->processPrompt(edited);
  } catch (const std::exception&) {
    // How the overflow surfaces does not matter; the state it leaves does.
  }
  LlmContext* context = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(context, nullptr);
  ASSERT_EQ(context->getNPast(), 0)
      << "the rollback did not land cold; the test cannot exercise the save";

  EXPECT_NO_THROW(model->saveCache(key));
  EXPECT_EQ(readBytes(key), saved)
      << "saveCache wrote an empty state over the last committed file";
  model.reset();
  fs::remove(key);
}

// An ephemeral batch conversation is dropped when its slot is evicted,
// instead of being written to its file.
TEST(ExplicitSaveTest, BatchEphemeralConversationIsDroppedOnEviction) {
  if (!fs::exists(test_common::BaseTestModelPath::get())) {
    GTEST_SKIP() << "base test model not found";
  }
  const std::vector<std::string> keys = {
      "ephemeral_evict_a.bin",
      "ephemeral_evict_b.bin",
      "ephemeral_evict_c.bin"};
  for (const auto& key : keys) {
    fs::remove(key);
  }
  {
    auto model = loadBatchedModel();
    ASSERT_TRUE(model->isLoaded());
    for (size_t i = 0; i < keys.size(); ++i) {
      const auto outputs = model->processPromptBatch({keyedPrompt(
          userTurns({"Say one word: " + std::to_string(i) + "."}),
          keys[i],
          true)});
      ASSERT_EQ(outputs.size(), 1u);
    }
    EXPECT_FALSE(fs::exists(keys[0]))
        << "the eviction wrote an ephemeral conversation";
  }
  for (const auto& key : keys) {
    EXPECT_FALSE(fs::exists(key)) << key << " was written at unload";
    fs::remove(key);
  }
}

// Checkpoints of conversations evicted to their file are kept for the key's
// next load, but at most one set per slot: a long-lived server cycling
// through many keys must not accumulate them without bound.
TEST(BatchedCheckpointStoreTest, KeepsAtMostOneCheckpointSetPerSlot) {
  const test_common::TestModelPath modelPath = hybridModelPath();
  if (!modelPath.found()) {
    GTEST_SKIP() << modelPath.missingMessage();
  }
  auto model = loadHybridChatModel(modelPath, "2");
  ASSERT_TRUE(model->isLoaded());
  auto* scheduler = LlamaModelTestPeer::scheduler(*model);
  ASSERT_NE(scheduler, nullptr);
  std::vector<std::string> keys;
  for (int i = 0; i < 5; ++i) {
    keys.push_back("checkpoint_store_" + std::to_string(i) + ".bin");
    fs::remove(keys.back());
  }
  for (size_t i = 0; i < keys.size(); ++i) {
    LlamaModel::Prompt prompt = keyedPrompt(
        chatInput({{"user", "Name colour number " + std::to_string(i) + "."}}),
        keys[i]);
    prompt.generationParams.n_predict = 8;
    ASSERT_EQ(model->processPromptBatch({prompt}).size(), 1u);
    EXPECT_LE(
        ContinuousBatchSchedulerTestPeer::checkpointStoreSize(*scheduler), 2u)
        << "after key " << i;
  }
  // Three keys were evicted; only the two most recent kept their checkpoints.
  EXPECT_EQ(
      ContinuousBatchSchedulerTestPeer::checkpointStoreSize(*scheduler), 2u);
  model.reset();
  for (const auto& key : keys) {
    fs::remove(key);
  }
}

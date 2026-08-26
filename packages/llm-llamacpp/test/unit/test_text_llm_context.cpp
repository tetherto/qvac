#include <chrono>
#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "common/chat.h"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/TextLlmContext.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"

using test_common::getStatValue;

namespace fs = std::filesystem;

namespace {

fs::path uniqueTextCachePath(const char* prefix) {
  const auto id =
      std::chrono::high_resolution_clock::now().time_since_epoch().count();
  return fs::temp_directory_path() /
         (std::string(prefix) + "-" + std::to_string(id) + ".bin");
}

void removeCacheFile(const fs::path& path) {
  if (fs::exists(path)) {
    fs::remove(path);
  }
}

llama_pos seqPosMax(LlamaModel& model, llama_seq_id seqId = 0) {
  auto* mem = llama_get_memory(model.getContext());
  if (mem == nullptr) {
    return -1;
  }
  return llama_memory_seq_pos_max(mem, seqId);
}

} // namespace

class TextLlmContextTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    test_model_path = test_common::BaseTestModelPath::get();
    test_projection_path = "";

    config_files["backendsDir"] = test_common::getTestBackendsDir().string();
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;

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
};

TEST_F(TextLlmContextTest, Constructor) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_TRUE(model->isLoaded());
}

TEST_F(TextLlmContextTest, LoadCacheReportsMissForEmptyKey) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlmModelContext shared{
      .model = model->getModel(),
      .lctx = model->getContext(),
      .vocab = llama_model_get_vocab(model->getModel()),
  };
  common_params params;
  TextLlmContext driver(params, shared, /*seqId=*/0);

  EXPECT_FALSE(driver.loadCache(/*cacheKey=*/""))
      << "an empty cache key must not load a cache";
}

TEST_F(TextLlmContextTest, LoadCacheClearsLegacyOneFieldMetadata) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt seedPrompt;
  seedPrompt.prefill = true;
  seedPrompt.input = R"([{"role": "user", "content": "Seed cache rows."}])";
  ASSERT_NO_THROW({ model->processPrompt(seedPrompt); });

  const llama_pos nPast = seqPosMax(*model) + 1;
  ASSERT_GT(nPast, 0);

  const fs::path cachePath = uniqueTextCachePath("legacy-seq-cache");
  const std::string cachePathString = cachePath.string();
  llama_token metadata[1] = {static_cast<llama_token>(nPast)};
  ASSERT_GT(
      llama_state_seq_save_file(
          model->getContext(), cachePathString.c_str(), 0, metadata, 1),
      0u);

  model->reset();
  ASSERT_EQ(seqPosMax(*model), -1);

  LlmModelContext shared{
      .model = model->getModel(),
      .lctx = model->getContext(),
      .vocab = llama_model_get_vocab(model->getModel()),
  };
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, /*seqId=*/0);

  EXPECT_FALSE(driver.loadCache(cachePathString));
  EXPECT_EQ(driver.getNPast(), 0);
  EXPECT_EQ(seqPosMax(*model), -1)
      << "legacy metadata load returned false but left KV rows resident";

  removeCacheFile(cachePath);
}

TEST_F(TextLlmContextTest, LoadCacheClearsRowsWhenMetadataNPastMismatches) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt seedPrompt;
  seedPrompt.prefill = true;
  seedPrompt.input = R"([{"role": "user", "content": "Seed bad cache rows."}])";
  ASSERT_NO_THROW({ model->processPrompt(seedPrompt); });

  const llama_pos nPast = seqPosMax(*model) + 1;
  ASSERT_GT(nPast, 0);

  const fs::path cachePath = uniqueTextCachePath("bad-npast-seq-cache");
  const std::string cachePathString = cachePath.string();
  llama_token metadata[2] = {
      static_cast<llama_token>(nPast + 1), static_cast<llama_token>(1)};
  ASSERT_GT(
      llama_state_seq_save_file(
          model->getContext(), cachePathString.c_str(), 0, metadata, 2),
      0u);

  model->reset();
  ASSERT_EQ(seqPosMax(*model), -1);

  LlmModelContext shared{
      .model = model->getModel(),
      .lctx = model->getContext(),
      .vocab = llama_model_get_vocab(model->getModel()),
  };
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, /*seqId=*/0);

  EXPECT_THROW(
      { (void)driver.loadCache(cachePathString); }, qvac_errors::StatusError);
  EXPECT_EQ(driver.getNPast(), 0);
  EXPECT_EQ(seqPosMax(*model), -1)
      << "failed sequence cache validation left loaded KV rows resident";

  removeCacheFile(cachePath);
}

TEST_F(TextLlmContextTest, LoadCacheRejectsRestoredTokenCountMetadataMismatch) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt seedPrompt;
  seedPrompt.prefill = true;
  seedPrompt.input = R"([{"role": "user", "content": "Seed cache rows."}])";
  ASSERT_NO_THROW({ model->processPrompt(seedPrompt); });

  const llama_pos nPast = seqPosMax(*model) + 1;
  ASSERT_GT(nPast, 0);

  const fs::path cachePath = uniqueTextCachePath("bad-cachetokens-seq-cache");
  const std::string cachePathString = cachePath.string();
  const llama_token metadata[SESSION_METADATA_FIELD_COUNT] = {
      static_cast<llama_token>(nPast),
      static_cast<llama_token>(1),
      static_cast<llama_token>(nPast + 1),
      static_cast<llama_token>(1)};
  ASSERT_GT(
      llama_state_seq_save_file(
          model->getContext(),
          cachePathString.c_str(),
          0,
          metadata,
          SESSION_METADATA_FIELD_COUNT),
      0u);

  model->reset();
  ASSERT_EQ(seqPosMax(*model), -1);

  LlmModelContext shared{
      .model = model->getModel(),
      .lctx = model->getContext(),
      .vocab = llama_model_get_vocab(model->getModel()),
  };
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, /*seqId=*/0);

  EXPECT_THROW(
      { (void)driver.loadCache(cachePathString); }, qvac_errors::StatusError);
  EXPECT_EQ(driver.getNPast(), 0);
  EXPECT_EQ(seqPosMax(*model), -1)
      << "failed cache-token validation left loaded KV rows resident";

  removeCacheFile(cachePath);
}

TEST_F(TextLlmContextTest, ProcessWithStringInput) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello, how are you?"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(TextLlmContextTest, ProcessWithCallback) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<std::string> generated_tokens;

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  prompt.outputCallback = [&generated_tokens](const std::string& token) {
    generated_tokens.push_back(token);
  };

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    EXPECT_GT(generated_tokens.size(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(TextLlmContextTest, ProcessAndGetRuntimeStats) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(TextLlmContextTest, ResetState) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);

    auto statsBefore = model->runtimeStats();
    EXPECT_GE(statsBefore.size(), 0);

    model->reset();
    auto statsAfter = model->runtimeStats();
    EXPECT_GE(statsAfter.size(), 0);
  });
}

TEST_F(TextLlmContextTest, LoadMediaDoesNothing) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> binary_input = {0x48, 0x65, 0x6c, 0x6c, 0x6f};
  if (test_projection_path.empty()) {
    LlamaModel::Prompt prompt;
    prompt.input = R"([{"role": "user", "content": "Hello"}])";
    prompt.media.push_back(std::move(binary_input));
    EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
  }
}

TEST_F(TextLlmContextTest, MultipleMessages) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "content": "Hello"}, {"role": "assistant", "content": "Hi there!"}, {"role": "user", "content": "How are you?"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(TextLlmContextTest, MultipleProcessCalls) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  LlamaModel::Prompt prompt2;
  prompt2.input = R"([{"role": "user", "content": "Follow up"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->processPrompt(prompt2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(TextLlmContextTest, CancelMethod) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW(model->cancel());
}

TEST_F(TextLlmContextTest, ProcessWithTools) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "What is the weather in Tokyo?"},
    {
      "type": "function",
      "name": "getWeather",
      "description": "Get weather forecast for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string", "description": "City name"},
          "date": {"type": "string", "description": "Date in YYYY-MM-DD"}
        },
        "required": ["city", "date"]
      }
    }
  ])";

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

// The text driver's half of the cache-warm rule. A prefill-only request never
// generates, so nothing will ever compact the reasoning span its prompt opens,
// and a cache that ends inside a force-open `<think>` leaves a fragment the
// next turn's full-state snapshot cannot rewind past. Differential: the same
// warm with compaction off decodes the opener, and the gap is its length.
// Hybrid only, a pure-attention rewind is positional and trims the opener even
// when it is already cached.
TEST_F(TextLlmContextTest, Qwen35HybridCacheWarmStopsBeforeForcedOpener) {
  const std::string hybridPath =
      test_common::BaseTestModelPath::get("Qwen3.5-0.8B-Q8_0.gguf");
  if (!std::filesystem::exists(hybridPath)) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  const auto warmPositions = [&](bool removeThinking) -> llama_pos {
    auto config = config_files;
    config["ctx_size"] = "4096";
    std::string path = hybridPath;
    std::string projection;
    auto model = std::make_unique<LlamaModel>(
        std::move(path), std::move(projection), std::move(config));
    model->waitForLoadInitialization();
    EXPECT_TRUE(model->isLoaded());
    if (!model->isLoaded()) {
      return -1;
    }
    auto* ctx = LlamaModelTestPeer::llmContext(*model);
    EXPECT_NE(ctx, nullptr);
    if (ctx == nullptr) {
      return -1;
    }
    LlamaModel::Prompt prompt;
    prompt.input = R"([{"role": "user", "content": "Is two plus two four?"}])";
    prompt.prefill = true;
    prompt.generationParams.remove_thinking_from_context = removeThinking;
    EXPECT_TRUE(model->processPrompt(prompt).empty());
    return ctx->getNPast();
  };

  const llama_pos withCompaction = warmPositions(/*removeThinking=*/true);
  const llama_pos withoutCompaction = warmPositions(/*removeThinking=*/false);
  ASSERT_GT(withCompaction, 0);
  ASSERT_GT(withoutCompaction, 0);
  EXPECT_EQ(withoutCompaction - withCompaction, 2)
      << "a cache warm must stop before the two-token `<think>` opener, "
         "withCompaction=" +
             std::to_string(withCompaction) +
             " withoutCompaction=" + std::to_string(withoutCompaction);
}

TEST_F(TextLlmContextTest, ProcessWithToolsInvalidFormat) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "Hello"},
    {
      "type": "function"
    }
  ])";

  EXPECT_THROW({ model->processPrompt(prompt); }, std::runtime_error);
}

TEST_F(TextLlmContextTest, ProcessWithMultipleTools) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "Search for laptops and add to cart"},
    {
      "type": "function",
      "name": "searchProducts",
      "description": "Search products",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {"type": "string", "description": "Search query"}
        },
        "required": ["query"]
      }
    },
    {
      "type": "function",
      "name": "addToCart",
      "description": "Add items to cart",
      "parameters": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {"type": "string"}
          }
        },
        "required": ["items"]
      }
    }
  ])";

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(TextLlmContextTest, ToolsPromptTokenizesWithToolDefinitions) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "What is the weather in Tokyo?"},
    {
      "type": "function",
      "name": "getWeather",
      "description": "Get weather forecast for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string", "description": "City name"},
          "date": {"type": "string", "description": "Date in YYYY-MM-DD"}
        },
        "required": ["city", "date"]
      }
    }
  ])";

  EXPECT_NO_THROW({ std::string output = model->processPrompt(prompt); });

  auto stats = model->runtimeStats();
  int cacheTokens = static_cast<int>(getStatValue(stats, "CacheTokens"));
  int promptTokens = static_cast<int>(getStatValue(stats, "promptTokens"));
  EXPECT_EQ(cacheTokens, 0);
  // prompt tokens with tools
  EXPECT_GT(promptTokens, 200);
}

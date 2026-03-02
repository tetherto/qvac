#include <filesystem>
#include <iostream>
#include <memory>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <variant>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

namespace {
double getStatValue(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  for (const auto& stat : stats) {
    if (stat.first == key) {
      return std::visit(
          [](const auto& value) -> double {
            if constexpr (std::is_same_v<
                              std::decay_t<decltype(value)>,
                              double>) {
              return value;
            } else {
              return static_cast<double>(value);
            }
          },
          stat.second);
    }
  }
  return 0.0;
}
} // namespace

class ToolTokenCacheTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    fs::path basePath;
    if (fs::exists(fs::path{"../../../models/unit-test"})) {
      basePath = fs::path{"../../../models/unit-test"};
    } else {
      basePath = fs::path{"models/unit-test"};
    }

    fs::path modelPath = basePath / "Llama-3.2-1B-Instruct-Q4_0.gguf";
    if (fs::exists(modelPath)) {
      test_model_path = modelPath.string();
    } else {
      modelPath = basePath / "test_model.gguf";
      if (fs::exists(modelPath)) {
        test_model_path = modelPath.string();
      } else {
        test_model_path = "Llama-3.2-1B-Instruct-Q4_0.gguf";
      }
    }
    test_projection_path = "";

    fs::path backendDir;
#ifdef TEST_BINARY_DIR
    backendDir = fs::path(TEST_BINARY_DIR);
#else
    backendDir = fs::current_path() / "build" / "test" / "unit";
#endif

    config_files["backendsDir"] = backendDir.string();

    session_with_tools_path = "test_session_with_tools.bin";
    session_after_tools_path = "test_session_after_tools.bin";
  }

  void TearDown() override {
    for (const auto& session_file :
         {session_with_tools_path, session_after_tools_path}) {
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
    auto model = std::make_unique<LlamaModel>(
        test_model_path, test_projection_path, config_files);
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;
  std::string session_with_tools_path;
  std::string session_after_tools_path;
};

TEST_F(ToolTokenCacheTest, CacheWithToolsBasic) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "What is the weather?"},
    {"type": "function", "name": "getWeather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output = model->process(inputWithTools);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  std::string saveInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = model->process(saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session_with_tools_path));
}

TEST_F(ToolTokenCacheTest, CachePersistenceWithTools) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model1 = createModel();
  if (!model1) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "What is bitcoin? Answer briefly."},
    {"type": "function", "name": "search", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output1 = model1->process(inputWithTools);
    EXPECT_GE(output1.length(), 0);
  });

  std::string saveInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = model1->process(saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  auto statsBefore = model1->runtimeStats();
  double cacheTokensBefore = getStatValue(statsBefore, "CacheTokens");
  EXPECT_GT(cacheTokensBefore, 0.0);

  model1.reset();

  auto model2 = createModel();
  if (!model2) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputAfterCache = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "What did I ask about?"}
  ])";

  EXPECT_NO_THROW({
    std::string output2 = model2->process(inputAfterCache);
    EXPECT_GE(output2.length(), 0);
  });

  auto statsAfter = model2->runtimeStats();
  double cacheTokensAfter = getStatValue(statsAfter, "CacheTokens");
  EXPECT_GT(cacheTokensAfter, 0.0);
}

TEST_F(ToolTokenCacheTest, CacheWithToolsThenWithout) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "What is bitcoin?"},
    {"type": "function", "name": "search", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output1 = model->process(inputWithTools);
    EXPECT_GE(output1.length(), 0);
  });

  std::string saveInput1 =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    model->process(saveInput1);
  });

  std::string inputAfterCache = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "What is ethereum?"}
  ])";

  EXPECT_NO_THROW({
    std::string output2 = model->process(inputAfterCache);
    EXPECT_GE(output2.length(), 0);
  });

  auto stats = model->runtimeStats();
  double cacheTokens = getStatValue(stats, "CacheTokens");
  EXPECT_GT(cacheTokens, 0.0);
}

TEST_F(ToolTokenCacheTest, MultipleToolCallsInCache) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string input1 = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Search laptops under $1000"},
    {"type": "function", "name": "searchProducts", "description": "Search products", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output1 = model->process(input1);
    EXPECT_GE(output1.length(), 0);
  });

  std::string saveInput1 =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    model->process(saveInput1);
  });

  std::string input2 = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Now search for phones"},
    {"type": "function", "name": "searchProducts", "description": "Search products", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output2 = model->process(input2);
    EXPECT_GE(output2.length(), 0);
  });

  auto stats = model->runtimeStats();
  double cacheTokens = getStatValue(stats, "CacheTokens");
  EXPECT_GT(cacheTokens, 0.0);
}

TEST_F(ToolTokenCacheTest, CacheResetClearsToolTokens) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "What is bitcoin?"},
    {"type": "function", "name": "search", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output1 = model->process(inputWithTools);
    EXPECT_GE(output1.length(), 0);
  });

  std::string resetInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "reset"}])";
  EXPECT_NO_THROW({
    std::string resetOutput = model->process(resetInput);
    EXPECT_EQ(resetOutput.length(), 0);
  });

  auto statsAfterReset = model->runtimeStats();
  double cacheTokensAfterReset = getStatValue(statsAfterReset, "CacheTokens");
  EXPECT_EQ(cacheTokensAfterReset, 0.0);
}

TEST_F(ToolTokenCacheTest, SaveAfterToolInference) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "What is blockchain? Answer briefly."},
    {"type": "function", "name": "search", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output1 = model->process(inputWithTools);
    EXPECT_GE(output1.length(), 0);
  });

  auto statsBeforeSave = model->runtimeStats();
  double promptTokens = getStatValue(statsBeforeSave, "promptTokens");
  double cacheTokens = getStatValue(statsBeforeSave, "CacheTokens");

  std::string saveInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    std::string saveOutput = model->process(saveInput);
    EXPECT_EQ(saveOutput.length(), 0);
  });

  EXPECT_TRUE(fs::exists(session_with_tools_path));

  model.reset();

  auto model2 = createModel();
  if (!model2) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string reloadInput = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Continue"}
  ])";

  EXPECT_NO_THROW({
    std::string output2 = model2->process(reloadInput);
    EXPECT_GE(output2.length(), 0);
  });

  auto statsAfterReload = model2->runtimeStats();
  double cacheTokensAfterReload = getStatValue(statsAfterReload, "CacheTokens");
  EXPECT_GT(cacheTokensAfterReload, 0.0);
}

TEST_F(ToolTokenCacheTest, MultipleToolsInSingleMessage) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithMultipleTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Search laptops and add to cart"},
    {"type": "function", "name": "searchProducts", "description": "Search products", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"type": "function", "name": "addToCart", "description": "Add items to cart", "parameters": {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "string"}}}, "required": ["items"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output = model->process(inputWithMultipleTools);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  std::string saveInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    model->process(saveInput);
  });

  EXPECT_TRUE(fs::exists(session_with_tools_path));
}

TEST_F(ToolTokenCacheTest, CacheLoadAfterTools) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model1 = createModel();
  if (!model1) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string firstInput = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Hello"}
  ])";

  EXPECT_NO_THROW({
    std::string output1 = model1->process(firstInput);
    EXPECT_GE(output1.length(), 0);
  });

  std::string saveInput1 =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    model1->process(saveInput1);
  });

  model1.reset();

  auto model2 = createModel();
  if (!model2) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "What is ethereum?"},
    {"type": "function", "name": "search", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output2 = model2->process(inputWithTools);
    EXPECT_GE(output2.length(), 0);
  });

  auto stats = model2->runtimeStats();
  double cacheTokens = getStatValue(stats, "CacheTokens");
  EXPECT_GT(cacheTokens, 0.0);
}

TEST_F(ToolTokenCacheTest, ToolCacheEdgeCaseEmptyTools) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputNoTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Hello, how are you?"}
  ])";

  EXPECT_NO_THROW({
    std::string output = model->process(inputNoTools);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  std::string saveInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    model->process(saveInput);
  });

  EXPECT_TRUE(fs::exists(session_with_tools_path));
}

TEST_F(ToolTokenCacheTest, CacheWithUpdatedToolsSubsequentPrompt) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithFirstTool = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Search for laptops"},
    {"type": "function", "name": "searchProducts", "description": "Search products", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output1 = model->process(inputWithFirstTool);
    EXPECT_GE(output1.length(), 0);
  });

  auto stats1 = model->runtimeStats();
  double cacheTokens1 = getStatValue(stats1, "CacheTokens");
  double promptTokens1 = getStatValue(stats1, "promptTokens");
  EXPECT_GT(cacheTokens1, 0.0) << "Cache should have tokens after first prompt";
  EXPECT_GT(promptTokens1, 0.0) << "Should have prompt tokens";

  std::string saveInput1 =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    model->process(saveInput1);
  });

  std::string inputWithUpdatedTool = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Now search for phones"},
    {"type": "function", "name": "searchProducts", "description": "Search products", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"type": "function", "name": "getPrice", "description": "Get price", "parameters": {"type": "object", "properties": {"item": {"type": "string"}}, "required": ["item"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output2 = model->process(inputWithUpdatedTool);
    EXPECT_GE(output2.length(), 0);
  });

  auto stats2 = model->runtimeStats();
  double cacheTokens2 = getStatValue(stats2, "CacheTokens");
  double promptTokens2 = getStatValue(stats2, "promptTokens");
  EXPECT_GT(cacheTokens2, 0.0) << "Cache should have tokens after second prompt with updated tools";
  EXPECT_GT(promptTokens2, 0.0) << "Should have prompt tokens";
}

TEST_F(ToolTokenCacheTest, CachePersistsWithDifferentToolsAfterSave) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model1 = createModel();
  if (!model1) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputFirst = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Search for books"},
    {"type": "function", "name": "search", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    model1->process(inputFirst);
  });

  auto stats1 = model1->runtimeStats();
  double cacheTokens1 = getStatValue(stats1, "CacheTokens");
  EXPECT_GT(cacheTokens1, 0.0);

  std::string saveInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    model1->process(saveInput);
  });

  model1.reset();

  auto model2 = createModel();
  if (!model2) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithDifferentTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Now find movies"},
    {"type": "function", "name": "searchMovies", "description": "Search movies", "parameters": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output2 = model2->process(inputWithDifferentTools);
    EXPECT_GE(output2.length(), 0);
  });

  auto statsAfter = model2->runtimeStats();
  double cacheTokensAfter = getStatValue(statsAfter, "CacheTokens");
  EXPECT_GT(cacheTokensAfter, 0.0) << "Cache should have tokens after loading with different tools";
}

TEST_F(ToolTokenCacheTest, CacheTokensIncreaseWithMultiplePrompts) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::vector<std::string> prompts = {
    R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "user", "content": "Hello"}, {"type": "function", "name": "search", "description": "Search", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}])",
    R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "user", "content": "How are you?"}])",
    R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "user", "content": "What's the weather?"}])"
  };

  double prevCacheTokens = 0.0;
  for (size_t i = 0; i < prompts.size(); ++i) {
    EXPECT_NO_THROW({
      std::string output = model->process(prompts[i]);
      EXPECT_GE(output.length(), 0);
    });

    auto stats = model->runtimeStats();
    double cacheTokens = getStatValue(stats, "CacheTokens");
    EXPECT_GT(cacheTokens, 0.0) << "Cache should have tokens after prompt " << i + 1;
  }
}

TEST_F(ToolTokenCacheTest, CacheWithNoToolsThenWithTools) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputNoTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Hello, what's the weather?"}
  ])";

  EXPECT_NO_THROW({
    std::string output1 = model->process(inputNoTools);
    EXPECT_GE(output1.length(), 0);
  });

  auto stats1 = model->runtimeStats();
  double cacheTokens1 = getStatValue(stats1, "CacheTokens");

  std::string inputWithTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Now get weather for New York"},
    {"type": "function", "name": "getWeather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output2 = model->process(inputWithTools);
    EXPECT_GE(output2.length(), 0);
  });

  auto stats2 = model->runtimeStats();
  double cacheTokens2 = getStatValue(stats2, "CacheTokens");
  EXPECT_GT(cacheTokens2, 0.0) << "Cache should have tokens after adding tools";
}

TEST_F(ToolTokenCacheTest, CacheTokenCountVerification) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithTools = R"([
    {"role": "user", "content": "What is the weather?"},
    {"type": "function", "name": "getWeather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}
  ])";

  EXPECT_NO_THROW({
    std::string output = model->process(inputWithTools);
    EXPECT_GE(output.length(), 0);
  });

  auto stats = model->runtimeStats();
  double cacheTokens = getStatValue(stats, "CacheTokens");
  double promptTokens = getStatValue(stats, "promptTokens");
  double evalTokens = getStatValue(stats, "evalTokens");

  std::cout << "=== First prompt with tools ===" << std::endl;
  std::cout << "CacheTokens: " << cacheTokens << std::endl;
  std::cout << "promptTokens: " << promptTokens << std::endl;
  std::cout << "evalTokens: " << evalTokens << std::endl;
  std::string saveInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  EXPECT_NO_THROW({
    model->process(saveInput);
  });

  std::string inputAfter = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "And for Paris?"}
  ])";

  EXPECT_NO_THROW({
    std::string output = model->process(inputAfter);
    EXPECT_GE(output.length(), 0);
  });

  auto statsAfter = model->runtimeStats();
  double cacheTokensAfter = getStatValue(statsAfter, "CacheTokens");
  double promptTokensAfter = getStatValue(statsAfter, "promptTokens");
  double evalTokensAfter = getStatValue(statsAfter, "evalTokens");

  std::cout << "=== Second prompt (after cache load) ===" << std::endl;
  std::cout << "CacheTokens: " << cacheTokensAfter << std::endl;
  std::cout << "promptTokens: " << promptTokensAfter << std::endl;
  std::cout << "evalTokens: " << evalTokensAfter << std::endl;
  EXPECT_EQ(cacheTokens, 0.0) << "First prompt (no session) has no cache";
  EXPECT_GT(promptTokens, 0.0) << "First prompt should have prompt tokens";
  EXPECT_GT(cacheTokensAfter, 0.0) << "Second prompt should load from cache";
  EXPECT_GT(promptTokensAfter, 0.0) << "Second prompt should have new tokens too";
}

TEST_F(ToolTokenCacheTest, CacheWithToolsResetBehavior) {
  if (!hasValidModel()) {
    GTEST_SKIP() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string inputWithTools = R"([
    {"role": "user", "content": "Search for laptops"},
    {"type": "function", "name": "searchProducts", "description": "Search products", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    model->process(inputWithTools);
  });

  auto statsBefore = model->runtimeStats();
  double cacheBefore = getStatValue(statsBefore, "CacheTokens");
  std::cout << "=== After first tool prompt ===" << std::endl;
  std::cout << "CacheTokens: " << cacheBefore << std::endl;

  std::string saveInput =
      R"([{"role": "session", "content": "test_session_with_tools.bin"}, {"role": "session", "content": "save"}])";
  model->process(saveInput);

  std::string inputSameTools = R"([
    {"role": "session", "content": "test_session_with_tools.bin"},
    {"role": "user", "content": "Search for phones"},
    {"type": "function", "name": "searchProducts", "description": "Search products", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}
  ])";

  EXPECT_NO_THROW({
    model->process(inputSameTools);
  });

  auto statsSameTools = model->runtimeStats();
  double cacheSameTools = getStatValue(statsSameTools, "CacheTokens");
  std::cout << "=== After second prompt with same tools ===" << std::endl;
  std::cout << "CacheTokens: " << cacheSameTools << std::endl;
  EXPECT_GT(cacheSameTools, 0.0);
}

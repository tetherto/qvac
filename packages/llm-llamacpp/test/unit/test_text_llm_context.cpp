#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "common/chat.h"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/TextLlmContext.hpp"
#include "test_common.hpp"

using test_common::getStatValue;

namespace fs = std::filesystem;

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

TEST_F(TextLlmContextTest, DoubleTokenizeWithoutToolsCompact) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "false";
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

TEST_F(TextLlmContextTest, DoubleTokenizeWithToolsCompactNoTools) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  config_files["tools"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello, how are you?"}])";

  EXPECT_NO_THROW({ std::string output = model->processPrompt(prompt); });

  // Without tools, CacheTokens should equal promptTokens (no cached
  // conversation tokens)
  auto stats = model->runtimeStats();
  int promptTokens = static_cast<int>(getStatValue(stats, "promptTokens"));
  EXPECT_LT(promptTokens, 50);
}

TEST_F(TextLlmContextTest, NPastBeforeToolsMinusOneWithoutTools) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "true";
  config_files["tools"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello, how are you?"}])";

  EXPECT_NO_THROW({ std::string output = model->processPrompt(prompt); });

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);
}

TEST_F(TextLlmContextTest, NPastBeforeToolsMinusOneWhenToolsCompactFalse) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_compact"] = "false";
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

  llama_pos nPastBeforeTools = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeTools, -1);
}

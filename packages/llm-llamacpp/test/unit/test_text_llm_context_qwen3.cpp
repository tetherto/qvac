#include <chrono>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <variant>
#include <vector>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

#include "common/chat.h"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/TextLlmContext.hpp"
#include "test_common.hpp"

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

bool isQwen3ModelPath(const std::string& path) {
  std::string lowerPath = path;
  std::transform(
      lowerPath.begin(),
      lowerPath.end(),
      lowerPath.begin(),
      [](unsigned char c) { return std::tolower(c); });
  return lowerPath.find("qwen3") != std::string::npos;
}
} // namespace

namespace fs = std::filesystem;

class TextLlmContextQwen3Test : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    // Use Qwen3 model if available, skip if not
    test_model_path = test_common::BaseTestModelPath::get(
        "Qwen3-1.7B-Q4_0.gguf", "Llama-3.2-1B-Instruct-Q4_0.gguf");
    test_projection_path = "";

    config_files["backendsDir"] = test_common::getTestBackendsDir().string();
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;

  bool hasValidModel() { return fs::exists(test_model_path); }
  bool isQwen3Model() { return isQwen3ModelPath(test_model_path); }

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

TEST_F(TextLlmContextQwen3Test, DoubleTokenizeWithToolsAtEnd) {
  if (!isQwen3Model()) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
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
  int promptTokens = static_cast<int>(getStatValue(stats, "promptTokens"));
  EXPECT_GT(promptTokens, 0);
}

TEST_F(TextLlmContextQwen3Test, DoubleTokenizeWithMultipleTools) {
  if (!isQwen3Model()) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  config_files["tools"] = "true";
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

  EXPECT_NO_THROW({ std::string output = model->processPrompt(prompt); });

  auto stats = model->runtimeStats();
  int promptTokens = static_cast<int>(getStatValue(stats, "promptTokens"));
  EXPECT_GT(promptTokens, 0);
}

TEST_F(TextLlmContextQwen3Test, DoubleTokenizeBoundaryAccuracy) {
  if (!isQwen3Model()) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
  config_files["tools"] = "true";
  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt promptWithTools;
  promptWithTools.input = R"([
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

  EXPECT_NO_THROW(
      { std::string output = model->processPrompt(promptWithTools); });

  auto statsWithTools = model->runtimeStats();
  int promptTokensWithTools =
      static_cast<int>(getStatValue(statsWithTools, "promptTokens"));
  EXPECT_GT(promptTokensWithTools, 150);

  EXPECT_NO_THROW({ model->reset(); });

  LlamaModel::Prompt promptNoTools;
  promptNoTools.input =
      R"([{"role": "user", "content": "What is the weather in Tokyo?"}])";

  EXPECT_NO_THROW(
      { std::string output = model->processPrompt(promptNoTools); });

  auto statsNoTools = model->runtimeStats();
  int promptTokensNoTools =
      static_cast<int>(getStatValue(statsNoTools, "promptTokens"));

  EXPECT_LT(promptTokensNoTools, 30);
}

TEST_F(TextLlmContextQwen3Test, NPastBeforeToolsSetAfterEvalWithTools) {
  if (!isQwen3Model()) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
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
  auto stats = model->runtimeStats();
  int promptTokens = static_cast<int>(getStatValue(stats, "promptTokens"));

  EXPECT_EQ(nPastBeforeTools, -1);
  EXPECT_GT(promptTokens, 0);
}

TEST_F(TextLlmContextQwen3Test, NPastBeforeToolsResetAfterResetState) {
  if (!isQwen3Model()) {
    GTEST_SKIP() << "Test requires Qwen3 model for tools_at_end feature";
  }

  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  config_files["tools_at_end"] = "true";
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

  llama_pos nPastBeforeToolsBeforeReset = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeToolsBeforeReset, -1);

  model->reset();

  llama_pos nPastBeforeToolsAfterReset = model->getNPastBeforeTools();
  EXPECT_EQ(nPastBeforeToolsAfterReset, -1);
}

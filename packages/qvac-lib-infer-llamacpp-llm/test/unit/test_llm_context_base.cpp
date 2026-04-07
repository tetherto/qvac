#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "common/chat.h"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/LlmContext.hpp"
#include "model-interface/MtmdLlmContext.hpp"
#include "model-interface/TextLlmContext.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

using test_common::getStatValue;

namespace {
std::string processPromptString(
    const std::unique_ptr<LlamaModel>& model, const std::string& input) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  return model->processPrompt(prompt);
}
} // namespace

class LlmContextBaseTest : public ::testing::Test {
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

  bool hasValidModel() { return fs::exists(test_model_path); }

  bool hasValidMultimodalModel() {
    std::string modelPath = test_common::BaseTestModelPath::get(
        "SmolVLM-500M-Instruct-Q8_0.gguf", "SmolVLM-500M-Instruct.gguf");
    std::string projectionPath = test_common::BaseTestModelPath::get(
        "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
        "mmproj-SmolVLM-500M-Instruct.gguf");
    return fs::exists(modelPath) && fs::exists(projectionPath);
  }

  std::unique_ptr<LlamaModel> createModel() {
    if (!hasValidModel()) {
      return nullptr;
    }
    std::string modelPathCopy = test_model_path;
    std::string projectionPathCopy = test_projection_path;
    auto configCopy = config_files;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPathCopy),
        std::move(projectionPathCopy),
        std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unique_ptr<LlamaModel> createMultimodalModel() {
    if (!hasValidMultimodalModel()) {
      return nullptr;
    }

    std::string modelPathStr = test_common::BaseTestModelPath::get(
        "SmolVLM-500M-Instruct-Q8_0.gguf", "SmolVLM-500M-Instruct.gguf");
    std::string projectionPathStr = test_common::BaseTestModelPath::get(
        "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
        "mmproj-SmolVLM-500M-Instruct.gguf");
    auto configCopy = config_files;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPathStr),
        std::move(projectionPathStr),
        std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;
};

TEST_F(LlmContextBaseTest, TextLlmContextProcessAndReset) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  auto stats = model->runtimeStats();
  EXPECT_GE(getStatValue(stats, "CacheTokens"), 0.0);

  EXPECT_NO_THROW({
    std::string output =
        processPromptString(model, R"([{"role": "user", "content": "Hello"}])");
    EXPECT_GE(output.length(), 0);
    auto statsAfter = model->runtimeStats();
    EXPECT_GE(statsAfter.size(), 0);
  });

  EXPECT_NO_THROW(model->reset());

  EXPECT_NO_THROW({
    std::string output2 = processPromptString(
        model, R"([{"role": "user", "content": "Another hello"}])");
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(LlmContextBaseTest, MtmdLlmContextProcessAndReset) {
  if (!hasValidMultimodalModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createMultimodalModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  auto stats = model->runtimeStats();
  EXPECT_GE(getStatValue(stats, "CacheTokens"), 0.0);

  EXPECT_NO_THROW({
    std::string output =
        processPromptString(model, R"([{"role": "user", "content": "Hello"}])");
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  EXPECT_NO_THROW(model->reset());

  EXPECT_NO_THROW({
    std::string output2 = processPromptString(
        model, R"([{"role": "user", "content": "Another hello"}])");
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(LlmContextBaseTest, ProcessAndGetRuntimeStats) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output =
        processPromptString(model, R"([{"role": "user", "content": "Hello"}])");
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GT(getStatValue(stats, "promptTokens"), 0.0);
  });
}

TEST_F(LlmContextBaseTest, ProcessWithCallback) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<std::string> tokens;

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  prompt.outputCallback = [&tokens](const std::string& token) {
    tokens.push_back(token);
  };

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    EXPECT_GT(tokens.size(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(LlmContextBaseTest, ResetStateClearsCache) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output =
        processPromptString(model, R"([{"role": "user", "content": "Hello"}])");
    EXPECT_GE(output.length(), 0);
  });

  model->reset();

  EXPECT_NO_THROW({
    std::string output2 = processPromptString(
        model, R"([{"role": "user", "content": "Another hello"}])");
    EXPECT_GE(output2.length(), 0);
    auto statsAfterReset = model->runtimeStats();
    EXPECT_EQ(getStatValue(statsAfterReset, "CacheTokens"), 0.0);
  });
}

TEST_F(LlmContextBaseTest, TextContextRejectsBinaryInput) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> media = {0x48, 0x65, 0x6c, 0x6c, 0x6f};

  if (test_projection_path.empty()) {
    LlamaModel::Prompt prompt;
    prompt.input = R"([{"role": "user", "content": "Hello"}])";
    prompt.media.push_back(std::move(media));
    EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
  }
}

TEST_F(LlmContextBaseTest, MultipleProcessCalls) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_NO_THROW({
    std::string output =
        processPromptString(model, R"([{"role": "user", "content": "Hello"}])");
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  EXPECT_NO_THROW({
    std::string output2 = processPromptString(
        model, R"([{"role": "user", "content": "Another hello"}])");
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(LlmContextBaseTest, VirtualDestructor) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  {
    auto model = createModel();
    if (!model) {
      FAIL() << "Model failed to load";
    }

    EXPECT_NO_THROW({
      std::string output = processPromptString(
          model, R"([{"role": "user", "content": "Hello"}])");
      EXPECT_GE(output.length(), 0);
      auto stats = model->runtimeStats();
      EXPECT_GE(stats.size(), 0);
    });
  }

  {
    auto model2 = createModel();
    if (model2) {
      EXPECT_NO_THROW({
        std::string output = processPromptString(
            model2, R"([{"role": "user", "content": "Test 2"}])");
        EXPECT_GE(output.length(), 0);
      });
    }
  }
}

TEST_F(LlmContextBaseTest, RuntimeStatsAccuracy) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";
  processPromptString(model, input);

  auto stats = model->runtimeStats();
  double promptTokens = getStatValue(stats, "promptTokens");
  double generatedTokens = getStatValue(stats, "generatedTokens");
  double cacheTokens = getStatValue(stats, "CacheTokens");

  EXPECT_GT(promptTokens, 0.0);
  EXPECT_GE(generatedTokens, 0.0);
  EXPECT_GE(cacheTokens, 0.0);
  EXPECT_GE(promptTokens, 1.0);
}

TEST_F(LlmContextBaseTest, RuntimeStatsConsistency) {
  if (!hasValidModel()) {
    FAIL() << "Test model not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::string input = R"([{"role": "user", "content": "Hello"}])";

  for (int i = 0; i < 3; ++i) {
    processPromptString(model, input);
    auto stats = model->runtimeStats();

    double promptTokens = getStatValue(stats, "promptTokens");
    double generatedTokens = getStatValue(stats, "generatedTokens");
    double cacheTokens = getStatValue(stats, "CacheTokens");

    EXPECT_GE(promptTokens, 0.0);
    EXPECT_GE(generatedTokens, 0.0);
    EXPECT_GE(cacheTokens, 0.0);
  }
}

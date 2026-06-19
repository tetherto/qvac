#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include "common/common.h"
#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

namespace {

constexpr int REASONING_BUDGET = 3;
constexpr int PREDICT_TOKENS = 10;
constexpr const char* THINKING_START_TAG = "<think>\n";
constexpr const char* THINKING_END_TAG = "\n</think>\n\n";

std::string sliceReasoning(const std::string& text) {
  const size_t open = text.find(THINKING_START_TAG);
  if (open == std::string::npos) {
    return "";
  }

  const size_t bodyStart = open + std::string(THINKING_START_TAG).size();
  const size_t close = text.find(THINKING_END_TAG, bodyStart);
  if (close == std::string::npos || close < bodyStart) {
    return "";
  }

  return text.substr(bodyStart, close - bodyStart);
}

size_t countTokens(llama_context* ctx, const std::string& text) {
  return common_tokenize(ctx, text, false, true).size();
}

struct RunResult {
  std::string output;
  size_t reasoningTokens = 0;
};

} // namespace

class ReasoningBudgetModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    qwen3Model_ =
        MP("Qwen3-0.6B-Q8_0.gguf",
           "QWEN3_MODEL_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF");

    config_["ctx_size"] = "4096";
    config_["n_predict"] = std::to_string(PREDICT_TOKENS);
    config_["seed"] = "50";
    config_["temp"] = "0";
    config_["top_p"] = "1";
    config_["device"] = test_common::getTestDevice();
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["backendsDir"] = test_common::getTestBackendsDir().string();
  }

  [[nodiscard]] bool hasQwen3Model() const {
    return qwen3Model_.found() && fs::exists(qwen3Model_.path);
  }

  std::unique_ptr<LlamaModel>
  createModel(std::unordered_map<std::string, std::string> config) {
    auto model = std::make_unique<LlamaModel>(
        std::string(qwen3Model_.path), std::string(), std::move(config));
    model->waitForLoadInitialization();
    return model;
  }

  RunResult runBudgetedPrompt(
      std::unordered_map<std::string, std::string> config,
      const GenerationParams& generationParams = {}) {
    auto model = createModel(std::move(config));
    if (!model->isLoaded()) {
      throw std::runtime_error("Qwen3 model failed to load");
    }

    LlamaModel::Prompt prompt;
    prompt.input =
        R"([{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"What is the capital of France? Answer in one word."}])";
    prompt.generationParams = generationParams;

    const std::string output = model->processPrompt(prompt);
    const std::string reasoning = sliceReasoning(output);
    return {output, countTokens(model->getContext(), reasoning)};
  }

  test_common::TestModelPath qwen3Model_;
  std::unordered_map<std::string, std::string> config_;
};

TEST_F(
    ReasoningBudgetModelTest,
    LoadTimeBudgetThreeGeneratesThreeReasoningTokens) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }

  auto config = config_;
  config["reasoning-budget"] = std::to_string(REASONING_BUDGET);

  const RunResult result = runBudgetedPrompt(std::move(config));

  EXPECT_NE(result.output.find(THINKING_START_TAG), std::string::npos)
      << result.output;
  EXPECT_NE(result.output.find(THINKING_END_TAG), std::string::npos)
      << result.output;
  EXPECT_EQ(result.reasoningTokens, REASONING_BUDGET) << result.output;
}

TEST_F(
    ReasoningBudgetModelTest,
    PerRequestBudgetThreeGeneratesThreeReasoningTokens) {
  if (!hasQwen3Model()) {
    GTEST_SKIP() << qwen3Model_.missingMessage();
  }

  GenerationParams generationParams;
  generationParams.reasoning_budget = REASONING_BUDGET;
  generationParams.n_predict = PREDICT_TOKENS;

  const RunResult result = runBudgetedPrompt(config_, generationParams);

  EXPECT_NE(result.output.find(THINKING_START_TAG), std::string::npos)
      << result.output;
  EXPECT_NE(result.output.find(THINKING_END_TAG), std::string::npos)
      << result.output;
  EXPECT_EQ(result.reasoningTokens, REASONING_BUDGET) << result.output;
}

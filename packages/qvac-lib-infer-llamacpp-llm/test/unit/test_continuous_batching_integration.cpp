#include <algorithm>
#include <cctype>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace {

/// Case-insensitive substring check. Used to assert generated text
/// contains an expected token (e.g. "Paris", "Moon") regardless of
/// capitalisation or surrounding punctuation the model may add.
bool containsCaseInsensitive(
    const std::string& haystack, const std::string& needle) {
  auto toLower = [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  };
  std::string hay_str(haystack.size(), '\0');
  std::string needle_str(needle.size(), '\0');
  std::transform(haystack.begin(), haystack.end(), hay_str.begin(), toLower);
  std::transform(needle.begin(), needle.end(), needle_str.begin(), toLower);
  return hay_str.find(needle_str) != std::string::npos;
}


class ContinuousBatchingIntegrationTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;

    config_["device"] = test_common::getTestDevice();
    config_["ctx_size"] = "1024";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["parallel"] = "4";
    config_["batch_size"] = "256";
    config_["n_predict"] = "32";
    config_["temp"] = "0";
    config_["backendsDir"] = test_common::getTestBackendsDir().string();

    model_ =
        MP("Llama-3.2-1B-Instruct-Q4_0.gguf", nullptr, MP::OnMissing::Skip,
           "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF");
  }

  std::unique_ptr<LlamaModel> loadModel() {
    std::string path = model_.path;
    std::string projection;
    auto cfg = config_;
    auto m = std::make_unique<LlamaModel>(
        std::move(path), std::move(projection), std::move(cfg));
    m->waitForLoadInitialization();
    return m;
  }

  static LlamaModel::Prompt makePrompt(const std::string& userText) {
    LlamaModel::Prompt p;
    p.input =
        R"([{"role":"user","content":")" + userText + R"("}])";
    return p;
  }

  std::unordered_map<std::string, std::string> config_;
  test_common::TestModelPath model_;
};

} // namespace

/// Single-prompt vector path must produce one non-empty output that
/// contains the expected concrete answer ("Paris").
TEST_F(ContinuousBatchingIntegrationTest, SinglePromptReturnsExpectedAnswer) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("What is the capital of France? Answer in one word.")};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_TRUE(containsCaseInsensitive(outputs[0], "Paris"))
      << "expected 'Paris' in: " << outputs[0];
}

/// Two prompts run together must each yield their concrete answers in
/// input order without cross-talk between sequences.
TEST_F(ContinuousBatchingIntegrationTest, TwoPromptsReturnExpectedAnswers) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("What is the capital of France? Answer in one word."),
      makePrompt("What is the natural satellite that orbits Earth? "
                 "Answer in one word.")};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_TRUE(containsCaseInsensitive(outputs[0], "Paris"))
      << "expected 'Paris' in: " << outputs[0];
  EXPECT_TRUE(containsCaseInsensitive(outputs[1], "Moon"))
      << "expected 'Moon' in: " << outputs[1];
  EXPECT_NE(outputs[0], outputs[1]);
}

/// `process(std::any)` dispatches on `vector<Prompt>` and round-trips
/// the resulting `vector<string>` payload.
TEST_F(ContinuousBatchingIntegrationTest, ProcessDispatchesVectorOfPrompts) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::vector<LlamaModel::Prompt> prompts{
      makePrompt("Say hi."), makePrompt("Say bye.")};
  std::any out = model->process(std::any(prompts));

  ASSERT_EQ(out.type(), typeid(std::vector<std::string>));
  const auto& outputs = std::any_cast<const std::vector<std::string>&>(out);
  ASSERT_EQ(outputs.size(), 2u);
  EXPECT_FALSE(outputs[0].empty());
  EXPECT_FALSE(outputs[1].empty());
}

/// Empty vector returns empty output without invoking the scheduler.
TEST_F(ContinuousBatchingIntegrationTest, EmptyVectorReturnsEmpty) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();
  auto outputs = model->processPromptBatch({});
  EXPECT_TRUE(outputs.empty());
}

/// Per-prompt `generationParams.n_predict` overrides cap each sequence
/// independently when both run in the same batch. The two prompts use a
/// long-form instruction so neither sequence is expected to hit EOG
/// before its cap; the smaller-cap prompt must therefore emit strictly
/// fewer token-pieces (and thus shorter text) than the larger-cap one,
/// and each piece-count must respect its own cap.
TEST_F(
    ContinuousBatchingIntegrationTest, PerPromptNPredictOverrideIsRespected) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  constexpr int kSmallNPredict = 8;
  constexpr int kLargeNPredict = 48;

  size_t piecesSmall = 0;
  size_t piecesLarge = 0;

  auto promptSmall = makePrompt(
      "Write a long, detailed paragraph about the history of astronomy.");
  promptSmall.generationParams.n_predict = kSmallNPredict;
  promptSmall.outputCallback = [&piecesSmall](const std::string&) {
    piecesSmall++;
  };

  auto promptLarge = makePrompt(
      "Write a long, detailed paragraph about the history of astronomy.");
  promptLarge.generationParams.n_predict = kLargeNPredict;
  promptLarge.outputCallback = [&piecesLarge](const std::string&) {
    piecesLarge++;
  };

  std::vector<LlamaModel::Prompt> prompts{
      std::move(promptSmall), std::move(promptLarge)};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 2u);

  // Each emit corresponds to at most one decoded token (UTF-8 buffering
  // can collapse partial pieces, so the count is an upper bound). The
  // per-sequence cap counts prompt + generated tokens; piece-counts only
  // observe the generated tail, so they must stay strictly below their
  // respective caps.
  EXPECT_LE(piecesSmall, static_cast<size_t>(kSmallNPredict))
      << "small-cap sequence emitted " << piecesSmall
      << " pieces, expected <= " << kSmallNPredict;
  EXPECT_LE(piecesLarge, static_cast<size_t>(kLargeNPredict))
      << "large-cap sequence emitted " << piecesLarge
      << " pieces, expected <= " << kLargeNPredict;

  // Cross-check the two caps actually take effect independently. Without
  // per-request plumbing both sequences would generate up to the same
  // batcher-wide ceiling and produce the same length.
  EXPECT_LT(piecesSmall, piecesLarge)
      << "expected smaller cap to truncate first: small=" << piecesSmall
      << ", large=" << piecesLarge;
  EXPECT_LT(outputs[0].size(), outputs[1].size())
      << "expected smaller cap to yield shorter text: small='" << outputs[0]
      << "', large='" << outputs[1] << "'";
}

/// Per-prompt outputCallback fires for every emitted piece, in addition
/// to the aggregated string returned by processPromptBatch.
TEST_F(ContinuousBatchingIntegrationTest, OutputCallbackStreamsPieces) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  std::string streamed;
  auto prompt = makePrompt("Say hi.");
  prompt.outputCallback = [&streamed](const std::string& piece) {
    streamed += piece;
  };
  std::vector<LlamaModel::Prompt> prompts{prompt};
  auto outputs = model->processPromptBatch(prompts);

  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_EQ(streamed, outputs[0]);
}

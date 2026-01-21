#include <filesystem>
#include <iostream>

#include <gtest/gtest.h>

#include "model-interface/TranslationModel.hpp"

namespace fs = std::filesystem;

static std::string getEnToItModelPath() { return "ggml-opus-en-it_q4_0.bin"; }

static std::string getItToEnModelPath() { return "ggml-opus-it-en_q4_0.bin"; }

static std::string getEnToIndicModelPath() {
  return "ggml-indictrans2-en-indic-dist-200M-q4_0.bin";
}

class TranslationModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    // Try different possible paths for models
    if (fs::exists(fs::path{"../../../models/unit-test"})) {
      basePath = fs::path{"../../../models/unit-test"};
    } else {
      basePath = fs::path{"models/unit-test"};
    }

    // Skip all tests if primary model (en→it) doesn't exist
    auto primaryModel = basePath / getEnToItModelPath();
    if (!fs::exists(primaryModel)) {
      GTEST_SKIP() << "Model not found: " << primaryModel.string() << "\n"
                   << "See models/unit-test/README.md for setup instructions.";
    }

    testInput =
        "Down, down, down. Would the fall never come to an end? \"I wonder how "
        "many miles I've fallen by this time?\" she said aloud.";
  }

  std::unique_ptr<qvac_lib_inference_addon_mlc_marian::TranslationModel>
  createModel(std::string_view ggmlFileName, bool useGpu = false) {
    auto modelPath = basePath / ggmlFileName;

    auto model =
        std::make_unique<qvac_lib_inference_addon_mlc_marian::TranslationModel>(
            modelPath.string());
    model->setUseGpu(useGpu);
    model->load();
    return model;
  }

  fs::path basePath;
  std::string testInput;
};

TEST_F(TranslationModelTest, EnglishToItalianTranslation) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);

  auto output = model->process(testInput);
  EXPECT_FALSE(output.empty());
  EXPECT_NE(output, testInput);

  std::cout << "EN->IT: " << testInput << " -> " << output << "\n";
}

TEST_F(TranslationModelTest, GPUTranslation) {
  std::cout << "Testing GPU translation...\n";
  auto model = createModel(getEnToItModelPath(), true); // Enable GPU
  ASSERT_NE(model, nullptr);

  auto output = model->process(testInput);
  EXPECT_FALSE(output.empty());
  EXPECT_NE(output, testInput);

  std::cout << "EN->IT (GPU): " << testInput << " -> " << output << "\n";
}

TEST_F(TranslationModelTest, ItalianToEnglishTranslation) {
  // Skip if it→en model is not available
  if (!fs::exists(basePath / getItToEnModelPath())) {
    GTEST_SKIP() << "Skipping: it→en model not found: " << getItToEnModelPath();
  }

  auto enItModel = createModel(getEnToItModelPath());
  ASSERT_NE(enItModel, nullptr);

  auto italianText = enItModel->process(testInput);
  EXPECT_FALSE(italianText.empty());

  auto itEnModel = createModel(getItToEnModelPath());
  ASSERT_NE(itEnModel, nullptr);

  auto backToEnglish = itEnModel->process(italianText);
  EXPECT_FALSE(backToEnglish.empty());
  EXPECT_NE(backToEnglish, italianText);

  std::cout << "EN->IT->EN: " << testInput << " -> " << italianText << " -> "
            << backToEnglish << "\n";
}

TEST_F(TranslationModelTest, MultipleModelsManagement) {
  // Skip if it→en model is not available
  if (!fs::exists(basePath / getItToEnModelPath())) {
    GTEST_SKIP() << "Skipping: it→en model not found: " << getItToEnModelPath();
  }

  std::vector<
      std::unique_ptr<qvac_lib_inference_addon_mlc_marian::TranslationModel>>
      models;

  models.emplace_back(createModel(getEnToItModelPath()));
  models.emplace_back(createModel(getItToEnModelPath()));

  ASSERT_EQ(models.size(), 2);
  ASSERT_NE(models[0], nullptr);
  ASSERT_NE(models[1], nullptr);

  auto output1 = models[0]->process(testInput);
  auto output2 = models[1]->process(output1);

  EXPECT_FALSE(output1.empty());
  EXPECT_FALSE(output2.empty());

  models.erase(models.begin());
  ASSERT_EQ(models.size(), 1);

  auto output3 = models[0]->process(output1);
  EXPECT_FALSE(output3.empty());

  std::cout << "Multi-model test: " << testInput << " -> " << output1 << " -> "
            << output3 << "\n";
}

TEST_F(TranslationModelTest, SaveLoadReloadFunctionality) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);

  auto outputBefore = model->process(testInput);
  EXPECT_FALSE(outputBefore.empty());

  model->saveLoadParams((basePath / getEnToItModelPath()).string());
  model->reload();

  auto outputAfter = model->process(testInput);
  EXPECT_FALSE(outputAfter.empty());
  EXPECT_EQ(outputBefore, outputAfter);

  std::cout << "Save/Load test: " << testInput << " -> " << outputAfter << "\n";
}

// TEST_F(TranslationModelTest, EnglishToHindiTranslation) {
//     auto model = createModel(getEnToIndicModelPath());
//     ASSERT_EQ(model->isLoaded(), true);
//     ASSERT_NE(model, nullptr);
//
//     std::string input = "Hello , my name is Bob";
//     auto output = model->process(input);
//     EXPECT_FALSE(output.empty());
//     EXPECT_EQ(output, "नमस्ते , मेरा नाम बॉब है ।");
//
//     std::cout << "EN->HI: " << input << " -> " << output << "\n";
// }

TEST_F(TranslationModelTest, NoRepeatNgramSizeTest) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);
  model->setConfig({{"norepeatngramsize", 2}});

  std::string input = "no no no no no";
  auto output = model->process(input);
  EXPECT_FALSE(output.empty());
  EXPECT_NE(output, "No no no no no");
  std::cout << "EN->IT: " << input << " -> " << output << "\n";

  std::string input2 = "hello world hello world hello world";
  auto output2 = model->process(input2);
  EXPECT_FALSE(output2.empty());
  EXPECT_NE(output2, "Ciao mondo Ciao mondo Ciao");
  std::cout << "EN->IT: " << input2 << " -> " << output2 << "\n";
}

TEST_F(TranslationModelTest, TemperatureTest) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);

  // Use a longer, more complex text to increase variability
  std::string input =
      "The old lighthouse stood on the rocky cliff, its weathered stones "
      "bearing witness to countless storms. Every evening, as the sun set "
      "over the horizon, the keeper would climb the spiral staircase to light "
      "the beacon. Ships passing in the night relied on its steady glow, "
      "a silent guardian watching over the treacherous waters below.";

  // Use sampling mode (beamsize=1) to make temperature have an effect
  // Temperature primarily affects sampling, not beam search
  // Low temperature (0.1) should produce more deterministic outputs
  model->setConfig(
      {{"temperature", 0.1}, {"beamsize", static_cast<int64_t>(1)}});

  auto output_low = model->process(input);
  EXPECT_FALSE(output_low.empty());
  EXPECT_NE(output_low, input);

  std::cout << "EN->IT (temp=0.1): " << output_low << "\n";

  // Moderate temperature (0.8) should produce different output
  // Note: Very high temperatures (>1.2) can break the model with gibberish
  // Note: The current implementation is deterministic (no random seed), so
  // the same temperature always produces the same output. We verify that
  // different temperatures produce different outputs.
  model->setConfig(
      {{"temperature", 0.8}, {"beamsize", static_cast<int64_t>(1)}});

  auto output_high = model->process(input);
  EXPECT_FALSE(output_high.empty());
  EXPECT_NE(output_high, input);

  std::cout << "EN->IT (temp=0.8): " << output_high << "\n";

  // Verify that different temperatures produce different outputs
  EXPECT_NE(output_low, output_high)
      << "Expected different outputs for different temperatures";
}

TEST_F(TranslationModelTest, RepetitionPenalty) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);

  std::string input =
      "He said said said said said said said said said said said said said "
      "said said said said said said it was fine.";
  auto output = model->process(input);
  EXPECT_FALSE(output.empty());
  std::cout << "EN->IT: " << input << " -> " << output << " : " << "\n";

  model->setConfig({{"repetitionpenalty", 1.9}});
  auto output2 = model->process(input);
  EXPECT_FALSE(output2.empty());
  std::cout << "EN->IT: " << input << " -> " << output2
            << " : With repetition penalty : " << 1.9f << "\n";

  EXPECT_NE(output2, output);
}

TEST_F(TranslationModelTest, LengthPenaltyBeamSearch) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);

  // Enable beam search with no length penalty
  model->setConfig(
      {{"beamsize", static_cast<int64_t>(8)}, {"lengthpenalty", 0.0}});
  std::string input = "While the committee acknowledged the proposal's merits, "
                      "it emphasized that, without a comprehensive risk "
                      "assessment and a realistic timeline for the follow-up "
                      "phases, any immediate rollout would be premature. "
                      "Nevertheless, given the public interest and the ongoing "
                      "discussions with regional partners, we agreed to "
                      "publish a condensed summary now and defer the full "
                      "recommendation until the next quarterly review.";
  auto out_no_lp = model->process(input);
  EXPECT_FALSE(out_no_lp.empty());

  // Apply length penalty
  model->setConfig(
      {{"beamsize", static_cast<int64_t>(8)}, {"lengthpenalty", 1.0}});
  auto out_lp = model->process(input);
  EXPECT_FALSE(out_lp.empty());

  // Expect a difference under length-normalized ranking
  EXPECT_NE(out_lp, out_no_lp);
}

TEST_F(TranslationModelTest, MaxLengthLimitsOutputTokens) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);

  std::string input =
      "As the storm intensified over the hills, the old lighthouse kept its "
      "steady pulse, "
      "guiding the few fishing boats that dared to stay out at sea, while the "
      "townsfolk "
      "boarded up their windows and settled in for a long, uneasy night.";

  auto out = model->process(input);
  EXPECT_FALSE(out.empty());

  model->setConfig(
      {{"maxlength", static_cast<int64_t>(10)},
       {"beamsize", static_cast<int64_t>(1)}});
  auto out_short = model->process(input);
  EXPECT_FALSE(out_short.empty());

  EXPECT_TRUE(out != out_short || out_short.size() < out.size());
}

TEST_F(TranslationModelTest, TopKSamplingChangesOutput) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);

  std::string input =
      "While the wind rattled the shutters, the radio crackled with updates, "
      "and "
      "neighbors checked on each other across the narrow street.";

  // Enable sampling with a relatively high temperature
  model->setConfig(
      {{"temperature", 0.9},
       {"beamsize", static_cast<int64_t>(1)},
       {"topk", static_cast<int64_t>(1)}});
  auto out_k1 = model->process(input);
  EXPECT_FALSE(out_k1.empty());

  // Increase top-k to allow more diverse choices
  model->setConfig(
      {{"temperature", 0.9},
       {"beamsize", static_cast<int64_t>(1)},
       {"topk", static_cast<int64_t>(40)}});
  auto out_k40 = model->process(input);
  EXPECT_FALSE(out_k40.empty());

  // Expect a difference between constrained and broader sampling
  EXPECT_NE(out_k1, out_k40);
}

TEST_F(TranslationModelTest, TopPSamplingChangesOutput) {
  auto model = createModel(getEnToItModelPath());
  ASSERT_NE(model, nullptr);

  std::string input = "The announcement sparked a wave of speculation online, "
                      "with commentators debating "
                      "the implications well into the night.";

  // Enable sampling with top-p nucleus filtering (tight nucleus)
  model->setConfig(
      {{"temperature", 0.9},
       {"beamsize", static_cast<int64_t>(1)},
       {"topk", static_cast<int64_t>(0)},
       {"topp", 0.7}});
  auto out_p07 = model->process(input);
  EXPECT_FALSE(out_p07.empty());

  // Looser nucleus retains more mass
  model->setConfig(
      {{"temperature", 0.9},
       {"beamsize", static_cast<int64_t>(1)},
       {"topk", static_cast<int64_t>(0)},
       {"topp", 0.95}});
  auto out_p095 = model->process(input);
  EXPECT_FALSE(out_p095.empty());

  EXPECT_NE(out_p07, out_p095);
}

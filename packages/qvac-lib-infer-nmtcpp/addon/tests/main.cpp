#include <filesystem>
#include <iostream>

#include <gtest/gtest.h>

#include "model-interface/TranslationModel.hpp"

namespace fs = std::filesystem;

class TranslationModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    basePath = fs::path{"model/nmt"};
    testInput =
        "Down, down, down. Would the fall never come to an end? \"I wonder how "
        "many miles I've fallen by this time?\" she said aloud.";
  }

  std::unique_ptr<qvac_lib_inference_addon_mlc_marian::TranslationModel>
  createModel(std::string_view ggmlFileName) {
    auto modelPath = basePath / ggmlFileName;
    return std::make_unique<
        qvac_lib_inference_addon_mlc_marian::TranslationModel>(
        modelPath.string());
  }

  fs::path basePath;
  std::string testInput;
};

TEST_F(TranslationModelTest, EnglishToItalianTranslation) {
  auto model = createModel("ggml-opus-en-it.bin");
  ASSERT_NE(model, nullptr);

  auto output = model->process(testInput);
  EXPECT_FALSE(output.empty());
  EXPECT_NE(output, testInput);

  std::cout << "EN->IT: " << testInput << " -> " << output << "\n";
}

TEST_F(TranslationModelTest, ItalianToEnglishTranslation) {
  auto enItModel = createModel("ggml-opus-en-it.bin");
  ASSERT_NE(enItModel, nullptr);

  auto italianText = enItModel->process(testInput);
  EXPECT_FALSE(italianText.empty());

  auto itEnModel = createModel("ggml-opus-it-en.bin");
  ASSERT_NE(itEnModel, nullptr);

  auto backToEnglish = itEnModel->process(italianText);
  EXPECT_FALSE(backToEnglish.empty());
  EXPECT_NE(backToEnglish, italianText);

  std::cout << "EN->IT->EN: " << testInput << " -> " << italianText << " -> "
            << backToEnglish << "\n";
}

TEST_F(TranslationModelTest, MultipleModelsManagement) {
  std::vector<
      std::unique_ptr<qvac_lib_inference_addon_mlc_marian::TranslationModel>>
      models;

  models.emplace_back(createModel("ggml-opus-en-it.bin"));
  models.emplace_back(createModel("ggml-opus-it-en.bin"));

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
  auto model = createModel("ggml-opus-en-it.bin");
  ASSERT_NE(model, nullptr);

  auto outputBefore = model->process(testInput);
  EXPECT_FALSE(outputBefore.empty());

  model->saveLoadParams((basePath / "ggml-opus-en-it.bin").string());
  model->reload();

  auto outputAfter = model->process(testInput);
  EXPECT_FALSE(outputAfter.empty());
  EXPECT_EQ(outputBefore, outputAfter);

  std::cout << "Save/Load test: " << testInput << " -> " << outputAfter << "\n";
}

TEST_F(TranslationModelTest, EnglishToHindiTranslation) {
  auto model = createModel("ggml-indictrans2-en-indic-dist-200M.bin");
  ASSERT_NE(model, nullptr);

  std::string input = "eng_Latn hin_Deva Hello , my name is Bob";
  auto output = model->process(input);
  EXPECT_FALSE(output.empty());
  EXPECT_EQ(output, "नमस्ते , मेरा नाम बॉब है ।");

  std::cout << "EN->HI: " << input << " -> " << output << "\n";
}

TEST_F(TranslationModelTest, HindiToEnglishTranslation) {
  auto model = createModel("ggml-indictrans2-indic-en-dist-200M.bin");
  ASSERT_NE(model, nullptr);

  std::string input = "hin_Deva eng_Latn नमस्ते , मेरा नाम बॉब है ।";
  auto output = model->process(input);
  EXPECT_FALSE(output.empty());
  EXPECT_EQ(output, "Hi , my name is Bob .");

  std::cout << "HI->EN: " << input << " -> " << output << "\n";
}

TEST_F(TranslationModelTest, HindiToUrduTranslation) {
  auto model = createModel("ggml-indictrans2-indic-indic-dist-320M.bin");
  ASSERT_NE(model, nullptr);

  std::string input = "hin_Deva urd_Arab नमस्ते , मेरा नाम बॉब है ।";
  auto output = model->process(input);
  EXPECT_FALSE(output.empty());
  EXPECT_EQ(output, "ہیلو ، میرا نام باب ہے ۔");

  std::cout << "HI->UR: " << input << " -> " << output << "\n";
}

TEST_F(TranslationModelTest, NoRepeatNgramSizeTest) {
  auto model = createModel("ggml-opus-en-it.bin");
  ASSERT_NE(model, nullptr);
  model->setConfig({{"norepeatngramsize", 2}});

  std::string input = "no no no no no";
  auto output = model->process(input);
  EXPECT_FALSE(output.empty());
  EXPECT_NE(output, "No no no no no");
  EXPECT_EQ(output, "No no no");
  std::cout << "EN->IT: " << input << " -> " << output << "\n";

  std::string input2 = "hello world hello world hello world";
  auto output2 = model->process(input2);
  EXPECT_FALSE(output2.empty());
  EXPECT_NE(output2, "Ciao mondo Ciao mondo Ciao");
  EXPECT_EQ(output2, "Ciao mondo Ci vediamo");
  std::cout << "EN->IT: " << input2 << " -> " << output2 << "\n";
}

TEST_F(TranslationModelTest, TemperatureTest) {
  auto model = createModel("ggml-opus-en-it.bin");
  ASSERT_NE(model, nullptr);
  model->setConfig({{"temperature", 0.1}});

  std::string input = "She looked out the window, lost in thought, as the rain "
                      "painted streaks on the glass.o";
  auto output = model->process(input);
  EXPECT_FALSE(output.empty());
  std::cout << "EN->IT: " << input << " -> " << output
            << " : With temperature : " << 0.1f << "\n";

  model->setConfig({{"temperature", 0.9}});
  auto output2 = model->process(input);
  EXPECT_FALSE(output2.empty());
  std::cout << "EN->IT: " << input << " -> " << output2
            << " : With temperature : " << 0.9f << "\n";

  EXPECT_NE(output2, output);
}

TEST_F(TranslationModelTest, RepetitionPenalty) {
  auto model = createModel("ggml-opus-en-it.bin");
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
  auto model = createModel("ggml-opus-en-it.bin");
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
  auto model = createModel("ggml-opus-en-it.bin");
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
  auto model = createModel("ggml-opus-en-it.bin");
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
  auto model = createModel(
      "/Users/sero/Desktop/repos/forks/mine/qvac-lib-nmtcpp/marian_aws/marian/"
      "ggml-opus-en-it/2025-08-07/ggml-opus-en-it.bin");
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

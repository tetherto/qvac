#include <filesystem>
#include <iostream>

#include <gtest/gtest.h>

#include "model-interface/TranslationModel.hpp"

namespace fs = std::filesystem;

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

    // Skip all tests if primary model (en→indic) doesn't exist
    auto primaryModel = basePath / getEnToIndicModelPath();
    if (!fs::exists(primaryModel)) {
      GTEST_SKIP() << "Model not found: " << primaryModel.string() << "\n"
                   << "See models/unit-test/README.md for setup instructions.";
    }

    testInput =
        "Down, down, down. Would the fall never come to an end? \"I wonder how "
        "many miles I've fallen by this time?\" she said aloud.";
  }

  std::unique_ptr<qvac_lib_inference_addon_marian::TranslationModel>
  createModel(std::string_view ggmlFileName, bool useGpu = false) {
    auto modelPath = basePath / ggmlFileName;

    auto model =
        std::make_unique<qvac_lib_inference_addon_marian::TranslationModel>(
            modelPath.string());
    model->setUseGpu(useGpu);
    model->load();
    return model;
  }

  fs::path basePath;
  std::string testInput;
};

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

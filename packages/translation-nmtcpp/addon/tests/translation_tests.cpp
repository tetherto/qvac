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

  std::unique_ptr<qvac_lib_inference_addon_nmt::TranslationModel>
  createModel(std::string_view ggmlFileName, bool useGpu = false) {
    auto modelPath = basePath / ggmlFileName;

    auto model =
        std::make_unique<qvac_lib_inference_addon_nmt::TranslationModel>(
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

TEST(NmtMainGpuConfigTest, ValidatesNativeConfigBeforeLoading) {
  qvac_lib_inference_addon_nmt::TranslationModel model;
  EXPECT_NO_THROW(model.setConfig({{"main-gpu", int64_t{0}}}));
  EXPECT_NO_THROW(model.setConfig({{"main_gpu", std::string{"integrated"}}}));
  EXPECT_NO_THROW(model.setConfig({{"main-gpu", std::string{"dedicated"}}}));
  EXPECT_NO_THROW(model.setConfig({{"main-gpu", 2.0}}));
  EXPECT_NO_THROW(model.setConfig({{"main-gpu", -1.0}}));
  EXPECT_NO_THROW(model.setConfig({{"main-gpu", std::string{"-1"}}}));
  EXPECT_NO_THROW(model.setConfig({{"main-gpu", std::string{"+2"}}}));
  EXPECT_NO_THROW(model.setConfig({{"main-gpu", std::string{"INTEGRATED"}}}));
  EXPECT_THROW(
      model.setConfig({{"main-gpu", std::string{"2junk"}}}),
      std::invalid_argument);
  EXPECT_THROW(
      model.setConfig({{"main-gpu", std::string{"2147483648"}}}),
      std::invalid_argument);
  EXPECT_THROW(model.setConfig({{"main-gpu", 0.5}}), std::invalid_argument);
  EXPECT_THROW(
      model.setConfig({{"main-gpu", std::string{"vulkan"}}}),
      std::invalid_argument);
  EXPECT_THROW(
      model.setConfig({{"main-gpu", int64_t{0}}, {"main_gpu", int64_t{0}}}),
      std::invalid_argument);
  for (const auto* legacy :
       {"gpu_backend", "gpuBackend", "gpu_device", "gpuDevice"}) {
    EXPECT_THROW(
        model.setConfig({{"main-gpu", int64_t{0}}, {legacy, int64_t{0}}}),
        std::invalid_argument);
  }
}

TEST(NmtMainGpuConfigTest, ReplacementConfigWithoutSelectorClearsMainGpu) {
  qvac_lib_inference_addon_nmt::TranslationModel model;

  model.setConfig(
      {{"use_gpu", int64_t{1}}, {"main-gpu", std::string{"dedicated"}}});
  ASSERT_TRUE(std::holds_alternative<std::string>(model.mainGpuForTesting()));
  EXPECT_FALSE(model.legacyGpuSelectionForTesting());

  model.setConfig({{"use_gpu", int64_t{1}}});
  EXPECT_TRUE(
      std::holds_alternative<std::monostate>(model.mainGpuForTesting()));
  EXPECT_FALSE(model.legacyGpuSelectionForTesting());

  model.setConfig(
      {{"use_gpu", int64_t{1}}, {"main-gpu", std::string{"dedicated"}}});
  ASSERT_TRUE(std::holds_alternative<std::string>(model.mainGpuForTesting()));

  model.setConfig({{"use_gpu", int64_t{1}}, {"gpu_device", int64_t{1}}});
  EXPECT_TRUE(
      std::holds_alternative<std::monostate>(model.mainGpuForTesting()));
  EXPECT_TRUE(model.legacyGpuSelectionForTesting());
  EXPECT_EQ(model.gpuDeviceForTesting(), 1);
}

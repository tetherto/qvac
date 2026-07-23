#include <any>
#include <atomic>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/SdModel.hpp"
#include "test_common.hpp"

using namespace qvac_lib_inference_addon_sd;

class SdSingleStepInferenceTest : public ::testing::Test {
protected:
  static std::unique_ptr<SdModel> model;

  static void SetUpTestSuite() {
    const auto path = sd_test_helpers::getModelPath();
    if (path.empty())
      return;

    SdCtxConfig config{};
    config.modelPath = path;
    config.prediction = V_PRED;
    config.nThreads = sd_test_helpers::getTestThreads();
    config.device = sd_test_helpers::getTestDevice();

    model = std::make_unique<SdModel>(std::move(config));
    model->load();
  }

  static void TearDownTestSuite() {
    model.reset(); // destructor releases GPU memory
  }

  void SetUp() override {
    if (!model)
      GTEST_SKIP() << "SD2.1 model not available — set SD_TEST_MODEL_PATH or "
                      "download to test/model/";
  }
};

std::unique_ptr<SdModel> SdSingleStepInferenceTest::model = nullptr;

TEST_F(SdSingleStepInferenceTest, SingleStepProducesValidPng) {
  std::vector<std::vector<uint8_t>> images;
  std::atomic<int> progressSteps{0};

  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "prompt": "solid white background",
    "negative_prompt": "",
    "steps": 1,
    "width": 512,
    "height": 512,
    "cfg_scale": 7.0,
    "seed": 1
  })";

  job.progressCallback = [&](const std::string& json) {
    progressSteps.fetch_add(1);
    std::cout << "\r  " << json << std::flush;
  };

  job.outputCallback = [&](const std::vector<uint8_t>& png) {
    images.push_back(png);
    std::cout << "\n  Output: " << png.size() << " bytes" << std::endl;
  };

  EXPECT_NO_THROW(model->process(std::any(job)));

  ASSERT_EQ(images.size(), 1u) << "Expected exactly 1 output image";
  EXPECT_GT(images[0].size(), 0u) << "Image must be non-empty";
  EXPECT_TRUE(sd_test_helpers::isPng(images[0])) << "Output must be valid PNG";
  EXPECT_GE(progressSteps.load(), 1) << "At least 1 progress tick expected";
}

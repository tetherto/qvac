#include <any>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/SdModel.hpp"
#include "test_common.hpp"

using namespace qvac_lib_inference_addon_sd;

// ---------------------------------------------------------------------------
// Mirrors the JS integration test in generate-image.test.js:
//   model  : stable-diffusion-v2-1-Q8_0.gguf
//   prompt : "a red fox in a snowy forest, photorealistic"
//   neg    : "blurry, low quality, watermark"
//   steps  : 10       cfg_scale : 7.5
//   width  : 712      height    : 712
//   seed   : 42       prediction: v (SD2.1 v-prediction)
// ---------------------------------------------------------------------------

class SdFullGenerationTest : public ::testing::Test {
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

std::unique_ptr<SdModel> SdFullGenerationTest::model = nullptr;

TEST_F(SdFullGenerationTest, Txt2ImgMatchesIntegrationConfig) {
  std::vector<std::vector<uint8_t>> images;
  std::vector<std::string> progressTicks;
  std::mutex mu;

  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "prompt": "a red fox in a snowy forest, photorealistic",
    "negative_prompt": "blurry, low quality, watermark",
    "steps": 10,
    "width": 712,
    "height": 712,
    "cfg_scale": 7.5,
    "seed": 42
  })";

  job.progressCallback = [&](const std::string& json) {
    std::lock_guard<std::mutex> lk(mu);
    progressTicks.push_back(json);
    std::cout << "\r  " << json << std::flush;
  };

  job.outputCallback = [&](const std::vector<uint8_t>& png) {
    std::lock_guard<std::mutex> lk(mu);
    images.push_back(png);
    std::cout << "\n  Output: " << png.size() << " bytes" << std::endl;
  };

  EXPECT_NO_THROW(model->process(std::any(job)));

  // -- Image assertions (same checks as the JS test) -------------------------
  ASSERT_EQ(images.size(), 1u) << "Expected exactly 1 output image";

  const auto& img = images[0];
  EXPECT_GT(img.size(), 0u) << "Image must be non-empty";
  EXPECT_TRUE(sd_test_helpers::isPng(img))
      << "Image must have valid PNG magic bytes";

  // -- Progress assertions ----------------------------------------------------
  EXPECT_GT(progressTicks.size(), 0u)
      << "Must receive at least 1 progress tick";

  // The last tick should report total == 10 (the configured step count).
  // Progress JSON shape: {"step":N,"total":M,"elapsed_ms":T}
  const auto& lastTick = progressTicks.back();
  EXPECT_NE(lastTick.find("\"total\":10"), std::string::npos)
      << "Final progress tick must report total=10, got: " << lastTick;

  // -- Save output to output/ -------------------------------------------------
#ifdef PROJECT_ROOT
  const std::string outDir = std::string(PROJECT_ROOT) + "/output";
#else
  const std::string outDir = "output";
#endif
  std::filesystem::create_directories(outDir);
  const std::string outPath = outDir + "/cpp-sd2-txt2img-seed42.png";
  std::ofstream ofs(outPath, std::ios::binary);
  ofs.write(
      reinterpret_cast<const char*>(img.data()),
      static_cast<std::streamsize>(img.size()));
  ofs.close();
  std::cout << "  Saved → " << outPath << std::endl;

  // -- Runtime stats ----------------------------------------------------------
  const auto stats = model->runtimeStats();
  EXPECT_FALSE(stats.empty())
      << "runtimeStats() should be populated after generation";
}

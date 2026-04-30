#include <memory>
#include <string>

#include <gtest/gtest.h>

#include "model-interface/SdModel.hpp"
#include "test_common.hpp"

using namespace qvac_lib_inference_addon_sd;

class SdModelLoadingTest : public ::testing::Test {
protected:
  std::string modelPath;

  void SetUp() override {
    modelPath = sd_test_helpers::getModelPath();
    if (modelPath.empty())
      GTEST_SKIP() << "SD2.1 model not available — set SD_TEST_MODEL_PATH or "
                      "download to test/model/";
  }

  std::unique_ptr<SdModel> makeModel() {
    SdCtxConfig config{};
    config.modelPath = modelPath;
    config.prediction = V_PRED;
    config.nThreads = sd_test_helpers::getTestThreads();
    config.device = sd_test_helpers::getTestDevice();
    return std::make_unique<SdModel>(std::move(config));
  }
};

TEST_F(SdModelLoadingTest, LoadSD2ModelSucceeds) {
  auto model = makeModel();
  ASSERT_FALSE(model->isLoaded());

  EXPECT_NO_THROW(model->load());
  EXPECT_TRUE(model->isLoaded());
  // model goes out of scope here — destructor releases GPU memory
}

TEST_F(SdModelLoadingTest, DestructorReleasesResources) {
  // Verify that a loaded model is reported as loaded, then let the destructor
  // free resources by going out of scope.
  {
    auto model = makeModel();
    model->load();
    ASSERT_TRUE(model->isLoaded());
  } // destructor called here — must not crash
}

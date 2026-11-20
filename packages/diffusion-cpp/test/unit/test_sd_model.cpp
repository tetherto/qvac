#include <cstring>

#include <gtest/gtest.h>

#include "model-interface/SdModel.hpp"
#include "test_common.hpp"

using namespace qvac_lib_inference_addon_sd;

class SdModelTest : public ::testing::Test {};

TEST_F(SdModelTest, ConstructWithEmptyConfigDoesNotThrow) {
  SdCtxConfig config{};
  EXPECT_NO_THROW(SdModel model(std::move(config)));
}

TEST_F(SdModelTest, IsNotLoadedAfterConstruction) {
  SdCtxConfig config{};
  SdModel model(std::move(config));
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(SdModelTest, GetNameReturnsSdModel) {
  SdCtxConfig config{};
  SdModel model(std::move(config));
  EXPECT_EQ(model.getName(), "SdModel");
}

TEST_F(SdModelTest, DestroyUnloadedModelIsNoop) {
  SdCtxConfig config{};
  // Destructor on a never-loaded model must not crash.
  EXPECT_NO_THROW({ SdModel model(std::move(config)); });
}

TEST_F(SdModelTest, FitEnforcesDeclaredBoundsWithDefaultFrameCount) {
  for (const auto* policy : {"auto", "off"}) {
    SCOPED_TRACE(policy);
    SdCtxConfig config{};
    applySdCtxHandlers(
        config,
        {{"device", "cpu"},
         {"performance_profile", policy},
         {"performance_max_width", "512"},
         {"performance_max_height", "320"},
         {"performance_max_frames", "97"}});
    SdModel model(std::move(config));
    SdModel::FitWorkload workload;
    workload.width = 512;
    workload.height = 320;
    ASSERT_EQ(workload.videoFrames, 1);
    EXPECT_NO_THROW((void)model.assessFit(workload));

    const auto expectBoundsError = [&] {
      try {
        (void)model.assessFit(workload);
        ADD_FAILURE() << "Fit accepted dimensions above the declared bounds";
      } catch (const qvac_errors::StatusError& error) {
        EXPECT_NE(
            std::string(error.what())
                .find(
                    "Video dimensions exceed the declared performance_max_* "
                    "limits"),
            std::string::npos)
            << error.what();
      }
    };
    workload.width = 1024;
    expectBoundsError();
    workload.width = 512;
    workload.height = 640;
    expectBoundsError();
    workload.height = 320;
    workload.videoFrames = 97;
    EXPECT_NO_THROW((void)model.assessFit(workload));
    workload.videoFrames = 98;
    expectBoundsError();
    workload.width = 1024;
    workload.height = 640;
    workload.upscaleOnly = true;
    // Upscaling has its own fit planner. Missing ESRGAN weights must reach
    // that planner rather than being rejected by diffusion output bounds.
    try {
      (void)model.assessFit(workload);
      ADD_FAILURE() << "Upscale fit unexpectedly accepted missing weights";
    } catch (const qvac_errors::StatusError& error) {
      EXPECT_NE(
          std::string(error.what())
              .find("the engine cannot read the model or measure this load"),
          std::string::npos)
          << error.what();
    }
    EXPECT_FALSE(model.isLoaded());
  }
}

namespace {
sd_fit_device_t hostEntry() {
  sd_fit_device_t host{};
  std::strncpy(host.name, "CPU", sizeof(host.name) - 1);
  host.host = true;
  host.used_bytes = 100;
  host.free_bytes = 1000;
  host.total_bytes = 2000;
  return host;
}
} // namespace

TEST_F(SdModelTest, FitOutcomeKeepsAnUnchangedPlacementAsFits) {
  sd_fit_device_t host = hostEntry();
  sd_fit_result_t result{};
  result.devices = &host;
  result.device_count = 1;
  const auto outcome = SdModel::fitOutcome(SD_FIT_SUCCESS, result, false);
  EXPECT_EQ(outcome.status, "fits");
  ASSERT_EQ(outcome.devices.size(), 1U);
  EXPECT_TRUE(outcome.devices[0].unified);
}

TEST_F(SdModelTest, FitOutcomeReadsAReplannedPlacementAsDoesNotFit) {
  sd_fit_device_t host = hostEntry();
  sd_fit_result_t result{};
  result.devices = &host;
  result.device_count = 1;
  EXPECT_EQ(
      SdModel::fitOutcome(SD_FIT_SUCCESS, result, true).status, "does-not-fit");
  EXPECT_EQ(
      SdModel::fitOutcome(SD_FIT_FAILURE, result, false).status,
      "does-not-fit");
}

TEST_F(SdModelTest, FitOutcomeWithoutEntriesIsUnknown) {
  sd_fit_result_t result{};
  const auto outcome = SdModel::fitOutcome(SD_FIT_SUCCESS, result, false);
  EXPECT_EQ(outcome.status, "unknown");
  EXPECT_TRUE(outcome.devices.empty());
}

TEST_F(SdModelTest, CoremlFitIsUnknownWithoutReadingWeights) {
  for (const bool unet : {true, false}) {
    SdCtxConfig config{};
    config.modelPath = "/missing/model.gguf";
    if (unet)
      config.coremlUnetPath = "/missing/unet.mlmodelc";
    else
      config.coremlTaeDecoderPath = "/missing/decoder.mlmodelc";
    SdModel model(std::move(config));
    const auto result = model.assessFit(SdModel::FitWorkload{});
    EXPECT_EQ(result.status, "unknown");
    EXPECT_TRUE(result.devices.empty());
  }
}

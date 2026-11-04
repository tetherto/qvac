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

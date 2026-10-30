#include <gtest/gtest.h>

#include "addon/FitResult.hpp"

namespace qvac::audiogenggml::addon_js {
namespace {

tts_cpp::acestep::FitResult cpuFit() {
  tts_cpp::acestep::FitResult fit;
  fit.status = tts_cpp::acestep::FitStatus::Success;
  fit.device_name = "CPU";
  fit.device_is_cpu = true;
  fit.peak_device_bytes = 200;
  fit.peak_host_bytes = 300;
  fit.host_free_bytes = 700;
  fit.host_total_bytes = 1000;
  return fit;
}

TEST(FitResult, CpuPrimaryRetainsAnIndependentLmPool) {
  auto fit = cpuFit();
  fit.extra_devices.push_back({"test-lm-gpu", false, 600, 900, 500});
  const auto result = toFitResult(fit);
  ASSERT_EQ(result.devices.size(), 2);
  EXPECT_EQ(result.devices[0].name, "test-lm-gpu");
  EXPECT_FALSE(result.devices[0].unified);
  EXPECT_EQ(result.devices[0].usedBytes, 500);
  EXPECT_EQ(result.devices[0].freeBytes, 600);
  EXPECT_EQ(result.devices[0].totalBytes, 900);
  EXPECT_EQ(result.devices[1].name, "CPU");
  EXPECT_TRUE(result.devices[1].unified);
  EXPECT_EQ(result.devices[1].usedBytes, 300);
}

TEST(FitResult, CpuOnlyCountsTheLargerHostPeakOnce) {
  auto fit = cpuFit();
  fit.peak_device_bytes = 400;
  const auto result = toFitResult(fit);
  EXPECT_EQ(result.status, "fits");
  ASSERT_EQ(result.devices.size(), 1);
  EXPECT_EQ(result.devices[0].usedBytes, 400);
}

TEST(FitResult, SeparatePoolsKeepTheirPeaksAndHostLast) {
  auto fit = cpuFit();
  fit.status = tts_cpp::acestep::FitStatus::Failure;
  fit.device_name = "test-primary-gpu";
  fit.device_is_cpu = false;
  fit.device_total_bytes = 1000;
  fit.extra_devices.push_back({"test-lm-gpu", true, 600, 900, 500});
  const auto result = toFitResult(fit);
  EXPECT_EQ(result.status, "does-not-fit");
  ASSERT_EQ(result.devices.size(), 3);
  EXPECT_EQ(result.devices[0].usedBytes, 200);
  EXPECT_EQ(result.devices[1].name, "test-lm-gpu");
  EXPECT_TRUE(result.devices[1].unified);
  EXPECT_EQ(result.devices[1].usedBytes, 500);
  EXPECT_EQ(result.devices[2].name, "CPU");
  EXPECT_EQ(result.devices[2].usedBytes, 300);
}

TEST(FitResult, CoreMLWithoutAnEstimateRemainsUnknown) {
  auto fit = cpuFit();
  fit.status = tts_cpp::acestep::FitStatus::Error;
  fit.reason = "coreml-memory-estimate-unavailable";
  const auto result = toFitResult(fit);
  EXPECT_EQ(result.status, "unknown");
  EXPECT_TRUE(result.devices.empty());
}

} // namespace
} // namespace qvac::audiogenggml::addon_js

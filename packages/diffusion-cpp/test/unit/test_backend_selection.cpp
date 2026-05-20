#include <string>
#include <unordered_map>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "utils/BackendSelection.hpp"

using namespace sd_backend_selection;

class SdBackendSelectionTest : public ::testing::Test {
protected:
  std::unordered_map<std::string, std::string> configMap;

  void SetUp() override { configMap.clear(); }
};

TEST_F(SdBackendSelectionTest, DeviceGpuReturnsGPU) {
  configMap["device"] = "gpu";
  EXPECT_EQ(preferredDeviceFromMap(configMap), BackendDevice::GPU);
}

TEST_F(SdBackendSelectionTest, DeviceCpuReturnsCPU) {
  configMap["device"] = "cpu";
  EXPECT_EQ(preferredDeviceFromMap(configMap), BackendDevice::CPU);
}

TEST_F(SdBackendSelectionTest, MissingDeviceDefaultsToGPU) {
  EXPECT_EQ(preferredDeviceFromMap(configMap), BackendDevice::GPU);
}

TEST_F(SdBackendSelectionTest, InvalidDeviceThrows) {
  configMap["device"] = "bogus";
  EXPECT_THROW(preferredDeviceFromMap(configMap), qvac_errors::StatusError);
}

TEST_F(SdBackendSelectionTest, ThreadsFromMapReturnsValue) {
  configMap["threads"] = "8";
  EXPECT_EQ(threadsFromMap(configMap), 8);
}

TEST_F(SdBackendSelectionTest, ThreadsFromMapDefaultsToAuto) {
  EXPECT_EQ(threadsFromMap(configMap), -1);
}

TEST_F(SdBackendSelectionTest, ResolveBackendCpuPreferenceReturnsCPU) {
  EXPECT_EQ(resolveBackendForDevice(BackendDevice::CPU), BackendDevice::CPU);
}

TEST_F(SdBackendSelectionTest, CpuPreferenceDoesNotPreferOpenCl) {
  EXPECT_FALSE(shouldPreferOpenClForAdreno(BackendDevice::CPU));
}

TEST_F(SdBackendSelectionTest, PreferredGpuBackendCpuDevice) {
  EXPECT_EQ(preferredGpuBackendForConfigDevice("cpu"), SD_BACKEND_PREF_CPU);
}

TEST_F(SdBackendSelectionTest, PreferredGpuBackendAutoDevice) {
  EXPECT_EQ(preferredGpuBackendForConfigDevice("auto"), SD_BACKEND_PREF_AUTO);
}

TEST_F(SdBackendSelectionTest, PreferredGpuBackendGpuDeviceIsGpuOrCpu) {
  const auto pref = preferredGpuBackendForConfigDevice("gpu");
  EXPECT_TRUE(
      pref == SD_BACKEND_PREF_GPU || pref == SD_BACKEND_PREF_OPENCL ||
      pref == SD_BACKEND_PREF_CPU);
}

TEST_F(SdBackendSelectionTest, ExpectedEsrganBackendCpuConfig) {
  EXPECT_EQ(expectedEsrganBackendDeviceForConfig("cpu"), "cpu");
}

TEST_F(SdBackendSelectionTest, ExpectedEsrganBackendGpuConfigIsCpuOrGpu) {
  const std::string expected = expectedEsrganBackendDeviceForConfig("gpu");
  EXPECT_TRUE(expected == "cpu" || expected == "gpu");
  const auto pref = preferredGpuBackendForConfigDevice("gpu");
  if (pref == SD_BACKEND_PREF_CPU) {
    EXPECT_EQ(expected, "cpu");
  } else {
    EXPECT_EQ(expected, "gpu");
  }
}

TEST_F(SdBackendSelectionTest, ParseConfigDeviceEmptyIsAuto) {
  EXPECT_EQ(parseConfigDeviceString(""), ConfigDevice::Auto);
  EXPECT_EQ(preferredGpuBackendForConfigDevice(""), SD_BACKEND_PREF_AUTO);
}

TEST_F(SdBackendSelectionTest, PreferredGpuBackendInvalidDeviceThrows) {
  EXPECT_THROW(
      preferredGpuBackendForConfigDevice("bogus"), qvac_errors::StatusError);
  EXPECT_THROW(
      preferredGpuBackendForConfigDevice("cuda"), qvac_errors::StatusError);
}

TEST_F(SdBackendSelectionTest, ExpectedEsrganBackendInvalidDeviceThrows) {
  EXPECT_THROW(
      expectedEsrganBackendDeviceForConfig("bogus"), qvac_errors::StatusError);
}

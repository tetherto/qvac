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
  const auto pref = preferredEsrganBackendForConfigDevice("gpu");
  if (pref == SD_BACKEND_PREF_CPU) {
    EXPECT_EQ(expected, "cpu");
  } else {
    EXPECT_EQ(expected, "gpu");
  }
}

#if defined(__ANDROID__)
TEST_F(SdBackendSelectionTest, AndroidEsrganGpuConfigForcesCpu) {
  EXPECT_EQ(expectedEsrganBackendDeviceForConfig("gpu"), "cpu");
  EXPECT_EQ(preferredEsrganBackendForConfigDevice("gpu"), SD_BACKEND_PREF_CPU);
  EXPECT_EQ(preferredEsrganBackendForConfigDevice("cpu"), SD_BACKEND_PREF_CPU);
}
#endif

TEST_F(SdBackendSelectionTest, AutoDeviceThrows) {
  EXPECT_THROW(
      preferredGpuBackendForConfigDevice("auto"), qvac_errors::StatusError);
  EXPECT_THROW(
      preferredEsrganBackendForConfigDevice("auto"), qvac_errors::StatusError);
  EXPECT_THROW(
      expectedEsrganBackendDeviceForConfig("auto"), qvac_errors::StatusError);
}

TEST_F(SdBackendSelectionTest, EmptyDeviceThrows) {
  EXPECT_THROW(
      preferredGpuBackendForConfigDevice(""), qvac_errors::StatusError);
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

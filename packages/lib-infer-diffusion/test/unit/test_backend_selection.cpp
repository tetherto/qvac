#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

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

TEST_F(SdBackendSelectionTest, ThreadsFromMapReturnsValue) {
  configMap["threads"] = "8";
  EXPECT_EQ(threadsFromMap(configMap), 8);
}

TEST_F(SdBackendSelectionTest, ThreadsFromMapDefaultsToAuto) {
  EXPECT_EQ(threadsFromMap(configMap), -1);
}

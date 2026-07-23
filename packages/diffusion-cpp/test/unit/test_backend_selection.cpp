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

// -- main-gpu ---------------------------------------------------------------

namespace {
MainGpuSpec indexSpec(int i) { return MainGpuSpec{MainGpuKind::Index, i}; }
const MainGpuSpec kDedicated{MainGpuKind::Dedicated, -1};
const MainGpuSpec kIntegrated{MainGpuKind::Integrated, -1};
} // namespace

TEST_F(SdBackendSelectionTest, ParseMainGpuSupportedValues) {
  const auto index = parseMainGpu("2");
  ASSERT_TRUE(index.has_value());
  EXPECT_EQ(index->kind, MainGpuKind::Index);
  EXPECT_EQ(index->index, 2);

  const auto integrated = parseMainGpu("Integrated");
  ASSERT_TRUE(integrated.has_value());
  EXPECT_EQ(integrated->kind, MainGpuKind::Integrated);

  const auto dedicated = parseMainGpu("dedicated");
  ASSERT_TRUE(dedicated.has_value());
  EXPECT_EQ(dedicated->kind, MainGpuKind::Dedicated);
}

TEST_F(SdBackendSelectionTest, ParseMainGpuInvalidValuesThrow) {
  EXPECT_FALSE(parseMainGpu("").has_value());
  EXPECT_THROW(parseMainGpu("-1"), qvac_errors::StatusError);
  EXPECT_THROW(parseMainGpu("3abc"), qvac_errors::StatusError);
  EXPECT_THROW(parseMainGpu("bogus"), qvac_errors::StatusError);
}

TEST_F(SdBackendSelectionTest, MainGpuFromMapReadsAliasesAndRejectsConflict) {
  EXPECT_FALSE(mainGpuFromMap(configMap).has_value());

  configMap["main-gpu"] = "dedicated";
  ASSERT_TRUE(mainGpuFromMap(configMap).has_value());
  EXPECT_EQ(mainGpuFromMap(configMap).value(), "dedicated");

  configMap.clear();
  configMap["main_gpu"] = "1";
  ASSERT_TRUE(mainGpuFromMap(configMap).has_value());
  EXPECT_EQ(mainGpuFromMap(configMap).value(), "1");

  configMap["main-gpu"] = "integrated";
  EXPECT_THROW(mainGpuFromMap(configMap), qvac_errors::StatusError);
}

TEST_F(SdBackendSelectionTest, SelectMainGpuByIndexAndType) {
  const std::vector<GpuCandidate> devices{
      {"CPU", GpuClass::Other, 0},
      {"iGPU", GpuClass::Integrated, 0},
      {"Vulkan0", GpuClass::Dedicated, 8000},
      {"Vulkan1", GpuClass::Dedicated, 16000},
  };

  const auto byIndex = selectMainGpuName(devices, indexSpec(1));
  ASSERT_TRUE(byIndex.has_value());
  EXPECT_EQ(byIndex.value(), "Vulkan0");

  const auto dedicated = selectMainGpuName(devices, kDedicated);
  ASSERT_TRUE(dedicated.has_value());
  EXPECT_EQ(dedicated.value(), "Vulkan1");

  const auto integrated = selectMainGpuName(devices, kIntegrated);
  ASSERT_TRUE(integrated.has_value());
  EXPECT_EQ(integrated.value(), "iGPU");
}

TEST_F(SdBackendSelectionTest, SelectMainGpuIntegratedCanPickOpenClAdrenoGpu) {
  const std::vector<GpuCandidate> devices{
      {"CPU", GpuClass::Other, 0},
      {"GPUOpenCL", GpuClass::Dedicated, 0, "QUALCOMM Adreno(TM) 840"},
      {"Vulkan0", GpuClass::Dedicated, 8000},
  };

  const auto integrated = selectMainGpuName(devices, kIntegrated);
  ASSERT_TRUE(integrated.has_value());
  EXPECT_EQ(integrated.value(), "GPUOpenCL");

  const auto dedicated = selectMainGpuName(devices, kDedicated);
  ASSERT_TRUE(dedicated.has_value());
  EXPECT_EQ(dedicated.value(), "Vulkan0");
}

TEST_F(SdBackendSelectionTest, SelectMainGpuNoMatchingClassIsNullopt) {
  const std::vector<GpuCandidate> devices{{"CPU", GpuClass::Other, 0}};
  EXPECT_FALSE(selectMainGpuName(devices, kDedicated).has_value());
  EXPECT_FALSE(selectMainGpuName(devices, kIntegrated).has_value());
  EXPECT_FALSE(selectMainGpuName(devices, indexSpec(1)).has_value());
}

#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/nmt_utils.hpp"

namespace {
struct MockDevice {
  std::string name;
  std::string registry;
  enum ggml_backend_dev_type type;
  bool hasBuffer = true;
  bool isNull = false;
};

thread_local std::vector<MockDevice>* devices = nullptr;

size_t deviceCount() { return devices != nullptr ? devices->size() : 0; }

ggml_backend_dev_t deviceGet(size_t index) {
  if (devices == nullptr || index >= devices->size()) {
    return nullptr;
  }
  if (devices->at(index).isNull) {
    return nullptr;
  }
  return reinterpret_cast<ggml_backend_dev_t>(&devices->at(index));
}

MockDevice* mockDevice(ggml_backend_dev_t device) {
  return reinterpret_cast<MockDevice*>(device);
}

enum ggml_backend_dev_type deviceType(ggml_backend_dev_t device) {
  return mockDevice(device)->type;
}

const char* deviceName(ggml_backend_dev_t device) {
  return mockDevice(device)->name.c_str();
}

ggml_backend_reg_t deviceRegistry(ggml_backend_dev_t device) {
  return reinterpret_cast<ggml_backend_reg_t>(device);
}

const char* registryName(ggml_backend_reg_t registry) {
  return reinterpret_cast<MockDevice*>(registry)->registry.c_str();
}

ggml_backend_buffer_type_t deviceBufferType(ggml_backend_dev_t device) {
  if (!mockDevice(device)->hasBuffer) {
    return nullptr;
  }
  return reinterpret_cast<ggml_backend_buffer_type_t>(device);
}

class NmtGpuSelectionTest : public testing::Test {
protected:
  std::vector<MockDevice> inventory;
  NmtBackendInterface backend{
      .deviceCount = deviceCount,
      .deviceGet = deviceGet,
      .deviceType = deviceType,
      .deviceName = deviceName,
      .deviceRegistry = deviceRegistry,
      .registryName = registryName,
      .deviceBufferType = deviceBufferType};

  void SetUp() override { devices = &inventory; }
  void TearDown() override { devices = nullptr; }

  ggml_backend_dev_t select(
      const std::string& requested = {}, int ordinal = 0,
      bool allowDefaultOpenCl = false) {
    return nmtSelectGpuDevice(
        backend,
        true,
        requested,
        ordinal,
        "test",
        allowDefaultOpenCl,
        {},
        true);
  }
};

TEST_F(NmtGpuSelectionTest, RocmBeforeVulkanChoosesVulkan) {
  inventory = {
      {"ROCm0", "HIP", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), deviceGet(1));
}

TEST_F(NmtGpuSelectionTest, RocmAfterVulkanChoosesVulkan) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"ROCm0", "HIP", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), deviceGet(0));
}

TEST_F(NmtGpuSelectionTest, RocmOnlyFallsBackToCpu) {
  inventory = {{"ROCm0", "HIP", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
}

TEST_F(NmtGpuSelectionTest, ExplicitRocmFallsBackToCpu) {
  inventory = {{"ROCm0", "HIP", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select("rocm"), nullptr);
}

TEST_F(NmtGpuSelectionTest, ExplicitDeviceNameSubstringRemainsSupported) {
  inventory = {{"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select("kan0"), deviceGet(0));
}

TEST_F(NmtGpuSelectionTest, AccelTypedVulkanIsRejected) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_ACCEL},
      {"Vulkan1", "Vulkan", GGML_BACKEND_DEVICE_TYPE_IGPU}};
  EXPECT_EQ(select(), deviceGet(1));
}

TEST_F(NmtGpuSelectionTest, MetaTypedVulkanIsRejected) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_META},
      {"Vulkan1", "Vulkan", GGML_BACKEND_DEVICE_TYPE_IGPU}};
  EXPECT_EQ(select(), deviceGet(1));
}

TEST_F(NmtGpuSelectionTest, MtlRegistryIdentityIsEligible) {
  inventory = {{"Apple M3", "MtL", GGML_BACKEND_DEVICE_TYPE_IGPU}};
  EXPECT_EQ(select("metal"), deviceGet(0));
}

TEST_F(NmtGpuSelectionTest, UnknownGpuFamilyFallsBackToCpu) {
  inventory = {{"Future0", "Future", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
}

TEST_F(NmtGpuSelectionTest, RpcRegistryFallsBackToCpu) {
  inventory = {{"RPC0", "RPC", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
}

TEST_F(NmtGpuSelectionTest, CudaRegistryIsEligible) {
  inventory = {{"CUDA0", "CUDA", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), deviceGet(0));
}

TEST_F(NmtGpuSelectionTest, ExplicitCudaIsEligibleAndExplicitRpcIsNot) {
  inventory = {
      {"CUDA0", "CUDA", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"RPC0", "RPC", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select("cuda"), deviceGet(0));
  EXPECT_EQ(select("rpc"), nullptr);
}

TEST_F(NmtGpuSelectionTest, RpcDeviceNameFallsBackToCpu) {
  inventory = {{"RPC0", "Future", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
}

TEST_F(NmtGpuSelectionTest, RegistryFamilyNamesRequireExactIdentity) {
  inventory = {{"Future0", "NotVulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
}

TEST_F(NmtGpuSelectionTest, DeviceFamilyNamesRequireKnownPrefixes) {
  inventory = {{"NotVulkan0", "Future", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
}

TEST_F(NmtGpuSelectionTest, DefaultOpenClGuardIsInjectable) {
  inventory = {
      {"OpenCL0", "OpenCL", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select({}, 0, true), deviceGet(0));
  EXPECT_EQ(select({}, 0, false), deviceGet(1));
}

TEST_F(NmtGpuSelectionTest, DefaultOrdinalCountsWithinEligibleInventory) {
  inventory = {
      {"ROCm0", "HIP", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"Vulkan1", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select({}, 0), deviceGet(1));
  EXPECT_EQ(select({}, 1), deviceGet(2));
}

TEST_F(NmtGpuSelectionTest, NullDeviceAndNullBufferFallBackSafely) {
  inventory = {
      {"Null0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU, true, true},
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU, false}};
  EXPECT_EQ(select(), nullptr);
  EXPECT_EQ(select({}, 1), nullptr);
}

TEST_F(NmtGpuSelectionTest, UnknownFamilyAfterEligibleIsSkipped) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"FutureBackend0", "FutureBackend", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), deviceGet(0));
}

TEST_F(NmtGpuSelectionTest, MusaIsRejectedByDeviceName) {
  inventory = {{"MUSA0", "MUSA", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
}

TEST_F(NmtGpuSelectionTest, MusaIsRejectedByRegistryName) {
  inventory = {{"SomeGpu", "MUSA", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
}

TEST_F(NmtGpuSelectionTest, DedicatedGpuOutranksEarlierIntegratedGpu) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_IGPU},
      {"Vulkan1", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), deviceGet(1));
  EXPECT_EQ(select({}, 1), deviceGet(0));
}

TEST_F(NmtGpuSelectionTest, ExplicitSelectorPrefersDedicatedGpu) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_IGPU},
      {"Vulkan1", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select("vulkan"), deviceGet(1));
}

TEST_F(NmtGpuSelectionTest, DefaultOpenClPrefersDedicatedGpu) {
  inventory = {
      {"OpenCL0", "OpenCL", GGML_BACKEND_DEVICE_TYPE_IGPU},
      {"OpenCL1", "OpenCL", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select({}, 0, true), deviceGet(1));
}

TEST_F(NmtGpuSelectionTest, RegistryOrderPreservedWithinDeviceClass) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"Vulkan1", "Vulkan", GGML_BACKEND_DEVICE_TYPE_IGPU},
      {"Vulkan2", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select({}, 0), deviceGet(0));
  EXPECT_EQ(select({}, 1), deviceGet(2));
  EXPECT_EQ(select({}, 2), deviceGet(1));
}

TEST_F(NmtGpuSelectionTest, SyclIsRejected) {
  inventory = {{"SYCL0", "SYCL", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(select(), nullptr);
  EXPECT_EQ(select("sycl"), nullptr);
}
TEST_F(NmtGpuSelectionTest, AutomaticDedicatedGpuOutranksOpenClIntegratedGpu) {
  inventory = {
      {"OpenCL0", "OpenCL", GGML_BACKEND_DEVICE_TYPE_IGPU},
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(
      nmtSelectGpuDevice(backend, true, {}, 0, "test", true), deviceGet(1));
  EXPECT_EQ(select({}, 0, true), deviceGet(0));
}

TEST_F(NmtGpuSelectionTest, MainGpuUsesRawRegistryIndexBeforeFiltering) {
  inventory = {
      {"ROCm0", "HIP", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_IGPU},
      {"CUDA0", "CUDA", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(
      nmtSelectGpuDevice(backend, true, {}, 0, "test", false, int64_t{0}),
      nullptr);
  EXPECT_EQ(
      nmtSelectGpuDevice(backend, true, {}, 0, "test", false, int64_t{1}),
      deviceGet(1));
  EXPECT_EQ(
      nmtSelectGpuDevice(backend, true, {}, 0, "test", false, int64_t{2}),
      deviceGet(2));
  // An invalid index uses normal dedicated-first automatic selection.
  EXPECT_EQ(
      nmtSelectGpuDevice(backend, true, {}, 0, "test", false, int64_t{-1}),
      deviceGet(2));
  EXPECT_EQ(
      nmtSelectGpuDevice(backend, true, {}, 0, "test", false, int64_t{99}),
      deviceGet(2));
}

TEST_F(NmtGpuSelectionTest, MainGpuClassSelectsOnlyRequestedClass) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_IGPU},
      {"Vulkan1", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(
      nmtSelectGpuDevice(
          backend, true, {}, 0, "test", false, std::string{"dedicated"}),
      deviceGet(1));
  EXPECT_EQ(
      nmtSelectGpuDevice(
          backend, true, {}, 0, "test", false, std::string{"integrated"}),
      deviceGet(0));
  inventory.pop_back();
  EXPECT_EQ(
      nmtSelectGpuDevice(
          backend, true, {}, 0, "test", false, std::string{"dedicated"}),
      nullptr);
}

TEST_F(NmtGpuSelectionTest, MainGpuCannotBypassCpuOrBackendGuards) {
  inventory = {
      {"CPU", "CPU", GGML_BACKEND_DEVICE_TYPE_CPU},
      {"RPC0", "RPC", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"OpenCL0", "OpenCL", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU, false},
      {"Vulkan1", "Vulkan", GGML_BACKEND_DEVICE_TYPE_GPU, true, true}};
  for (int64_t index = 0; index < 5; ++index) {
    EXPECT_EQ(
        nmtSelectGpuDevice(backend, true, {}, 0, "test", false, index),
        nullptr);
  }
  EXPECT_EQ(
      nmtSelectGpuDevice(backend, true, {}, 0, "test", true, int64_t{2}),
      deviceGet(2));
  EXPECT_EQ(
      nmtSelectGpuDevice(backend, false, {}, 0, "test", true, int64_t{2}),
      nullptr);
}

TEST_F(NmtGpuSelectionTest, MainGpuDoesNotInheritLegacySelection) {
  inventory = {
      {"Vulkan0", "Vulkan", GGML_BACKEND_DEVICE_TYPE_IGPU},
      {"CUDA0", "CUDA", GGML_BACKEND_DEVICE_TYPE_GPU}};
  EXPECT_EQ(
      nmtSelectGpuDevice(
          backend,
          true,
          "cuda",
          1,
          "test",
          false,
          std::string{"integrated"},
          true),
      deviceGet(0));
  EXPECT_EQ(
      nmtSelectGpuDevice(
          backend, true, "vulkan", 1, "test", false, int64_t{99}, true),
      deviceGet(1));
}

// QLOG (inference-addon-cpp/Logger.hpp) writes to std::cout, so the warning
// has to be captured from stdout; a stderr capture stays empty and the
// assertions below fail while the message shows up in the runner log.
TEST_F(NmtGpuSelectionTest, CpuFallbackWarnsWithEveryRefusedGpuIdentity) {
  inventory = {
      {"rocm0", "ROCm", GGML_BACKEND_DEVICE_TYPE_GPU},
      {"CPU", "CPU", GGML_BACKEND_DEVICE_TYPE_CPU},
      {"sycl0", "SYCL", GGML_BACKEND_DEVICE_TYPE_GPU}};
  testing::internal::CaptureStdout();
  const auto selected = nmtSelectGpuDevice(
      backend, true, {}, 0, "refused-test", false, {}, false);
  const std::string warning = testing::internal::GetCapturedStdout();
  EXPECT_EQ(selected, nullptr);
  EXPECT_NE(warning.find("no eligible device is available"), std::string::npos);
  EXPECT_NE(warning.find("rocm0 (ROCm)"), std::string::npos);
  EXPECT_NE(warning.find("sycl0 (SYCL)"), std::string::npos);
}

TEST_F(NmtGpuSelectionTest, MainGpuIneligibleTargetNamesRefusedDevice) {
  inventory = {{"rocm0", "ROCm", GGML_BACKEND_DEVICE_TYPE_GPU}};
  testing::internal::CaptureStdout();
  const auto selected = nmtSelectGpuDevice(
      backend, true, {}, 0, "main-gpu-test", false, int64_t{0}, false);
  const std::string warning = testing::internal::GetCapturedStdout();
  EXPECT_EQ(selected, nullptr);
  EXPECT_NE(warning.find("rocm0 (ROCm)"), std::string::npos);
}
} // namespace

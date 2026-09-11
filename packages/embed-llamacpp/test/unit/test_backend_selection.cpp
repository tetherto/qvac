#include <algorithm>
#include <cctype>
#include <deque>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "model-interface/BackendSelection.hpp"

using namespace backend_selection;

struct MockDevice {
  std::string description;
  std::string backend_name;
  std::string regName;
  enum ggml_backend_dev_type type;
  std::string deviceId;

  MockDevice(
      std::string&& desc, std::string&& backend,
      enum ggml_backend_dev_type devType, std::string&& reg = "standard")
      : description(std::move(desc)), backend_name(std::move(backend)),
        regName(std::move(reg)), type(devType) {}
};

static MockDevice withDeviceId(MockDevice device, std::string&& id) {
  device.deviceId = std::move(id);
  return device;
}

static MockDevice createGPUDevice(std::string&& desc, std::string&& backend) {
  return {std::move(desc), std::move(backend), GGML_BACKEND_DEVICE_TYPE_GPU};
}

static MockDevice createIGPUDevice(std::string&& desc, std::string&& backend) {
  return {std::move(desc), std::move(backend), GGML_BACKEND_DEVICE_TYPE_IGPU};
}

static MockDevice createACCELDevice(std::string&& desc, std::string&& backend) {
  return {std::move(desc), std::move(backend), GGML_BACKEND_DEVICE_TYPE_ACCEL};
}

static MockDevice createCPUDevice(std::string&& desc, std::string&& backend) {
  return {std::move(desc), std::move(backend), GGML_BACKEND_DEVICE_TYPE_CPU};
}

class MockBackendInterface {
public:
  std::vector<MockDevice> devices;
  std::vector<std::pair<ggml_log_level, std::string>> logs;
  mutable std::deque<std::string> string_storage;

  static thread_local MockBackendInterface* currentInstance;

  void addDevice(const MockDevice& device) { devices.push_back(device); }

  void clearDevices() {
    devices.clear();
    logs.clear();
    string_storage.clear();
  }

  BackendInterface toBackendInterface() const {
    const_cast<MockBackendInterface*>(this)->setCurrentInstance();

    return BackendInterface{
        &MockBackendInterface::static_dev_count,
        &MockBackendInterface::static_dev_backend_reg,
        &MockBackendInterface::static_dev_get,
        &MockBackendInterface::static_reg_name,
        &MockBackendInterface::static_dev_description,
        &MockBackendInterface::static_dev_name,
        &MockBackendInterface::static_dev_type,
        &MockBackendInterface::static_dev_get_props,
        &MockBackendInterface::static_llamaLogCallback};
  }

private:
  void setCurrentInstance() { currentInstance = this; }

  static size_t static_dev_count() {
    if (currentInstance != nullptr) {
      return currentInstance->devices.size();
    }
    return 0;
  }

  static ggml_backend_reg_t static_dev_backend_reg(ggml_backend_dev_t dev) {
    return reinterpret_cast<ggml_backend_reg_t>(dev);
  }

  static ggml_backend_dev_t static_dev_get(size_t index) {
    if (currentInstance && index < currentInstance->devices.size()) {
      return reinterpret_cast<ggml_backend_dev_t>(
          const_cast<MockDevice*>(&currentInstance->devices[index]));
    }
    return nullptr;
  }

  static const char* static_reg_name(ggml_backend_reg_t reg) {
    if (!currentInstance)
      return "";
    MockDevice* dev = reinterpret_cast<MockDevice*>(reg);
    if (dev) {
      currentInstance->string_storage.push_back(dev->regName);
      return currentInstance->string_storage.back().c_str();
    }
    return "";
  }

  static const char* static_dev_description(ggml_backend_dev_t dev) {
    if (!currentInstance)
      return "";
    MockDevice* mock_dev = reinterpret_cast<MockDevice*>(dev);
    if (mock_dev) {
      currentInstance->string_storage.push_back(mock_dev->description);
      return currentInstance->string_storage.back().c_str();
    }
    return "";
  }

  static const char* static_dev_name(ggml_backend_dev_t dev) {
    if (!currentInstance)
      return "";
    MockDevice* mock_dev = reinterpret_cast<MockDevice*>(dev);
    if (mock_dev) {
      currentInstance->string_storage.push_back(mock_dev->backend_name);
      return currentInstance->string_storage.back().c_str();
    }
    return "";
  }

  static enum ggml_backend_dev_type static_dev_type(ggml_backend_dev_t dev) {
    if (!currentInstance)
      return GGML_BACKEND_DEVICE_TYPE_CPU;
    MockDevice* mock_dev = reinterpret_cast<MockDevice*>(dev);
    if (mock_dev) {
      return mock_dev->type;
    }
    return GGML_BACKEND_DEVICE_TYPE_CPU;
  }

  static void static_dev_get_props(
      ggml_backend_dev_t dev, struct ggml_backend_dev_props* props) {
    *props = {};
    if (!currentInstance)
      return;
    MockDevice* mock_dev = reinterpret_cast<MockDevice*>(dev);
    if (mock_dev && !mock_dev->deviceId.empty()) {
      currentInstance->string_storage.push_back(mock_dev->deviceId);
      props->device_id = currentInstance->string_storage.back().c_str();
    }
  }

  static void static_llamaLogCallback(
      ggml_log_level level, const char* text, void* userData) {
    (void)userData;
    if (currentInstance != nullptr) {
      currentInstance->logs.emplace_back(level, text != nullptr ? text : "");
    }
  }
};

thread_local MockBackendInterface* MockBackendInterface::currentInstance =
    nullptr;

class BackendSelectionTest : public ::testing::Test {
protected:
  MockBackendInterface mockBackend;

  void SetUp() override {
    mockBackend.clearDevices();
    MockBackendInterface::currentInstance = nullptr;
  }

  void TearDown() override {
    MockBackendInterface::currentInstance = nullptr;
    mockBackend.clearDevices();
  }
};

constexpr const char* ADRENO_DESC = "Adreno (TM) 740";
// Generic non-Adreno Vulkan-capable device for testing the GPU / iGPU /
// main-gpu selection logic without tripping the Adreno-OpenCL override.
constexpr const char* INTEL_DESC = "Intel Iris Xe Graphics";

constexpr const char* VULKAN0_BACK = "Vulkan0";
constexpr const char* VULKAN1_BACK = "Vulkan1";
constexpr const char* OPENCL_BACK = "GPUOpenCL";

void expectChosen(
    const std::pair<BackendType, std::string>& result,
    BackendType expectedBackend, const std::string& expectedBackendName) {
  EXPECT_EQ(result.first, expectedBackend);
  std::string backendLower = result.second;
  std::transform(
      backendLower.begin(),
      backendLower.end(),
      backendLower.begin(),
      ::tolower);
  EXPECT_TRUE(backendLower.find(expectedBackendName) != std::string::npos);
}

void expectChosen(
    MockBackendInterface& mockBackend, BackendType expectedBackend,
    const std::string& expectedBackendName) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(expectedBackend, bckI);
  expectChosen(result, expectedBackend, expectedBackendName);
}

void expectChosen(
    MockBackendInterface& mockBackend, BackendType expectedBackend,
    const std::string& expectedBackendName,
    const std::optional<MainGpu>& mainGpu) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(expectedBackend, bckI, mainGpu);
  expectChosen(result, expectedBackend, expectedBackendName);
}

void expectChosenForPreference(
    MockBackendInterface& mockBackend, BackendType preferredBackend,
    BackendType expectedBackend, const std::string& expectedBackendName,
    const std::optional<MainGpu>& mainGpu = std::nullopt) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(preferredBackend, bckI, mainGpu);
  expectChosen(result, expectedBackend, expectedBackendName);
}

TEST_F(BackendSelectionTest, AdrenoOpenCLAndVulkanChoosesOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl");
}

TEST_F(BackendSelectionTest, AdrenoOpenCLAndIVulkanChoosesOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl");
}

TEST_F(
    BackendSelectionTest,
    AdrenoOpenCLAndIVulkanChoosesOpenCLMainGpuIntegrated) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl", mainGpu);
}

TEST_F(
    BackendSelectionTest, AdrenoOpenCLAndIVulkanChoosesOpenCLMainGpuDedicated) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MainGpu mainGpu = MainGpuType::Dedicated;
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl", mainGpu);
}

TEST_F(BackendSelectionTest, VulkanAndOpenCLNotAdrenoChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(INTEL_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(INTEL_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, VulkanIGPU) {
  mockBackend.addDevice(createIGPUDevice(INTEL_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, VulkanGPUOverIGPUWhenGPUBack) {
  mockBackend.addDevice(createIGPUDevice(INTEL_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(INTEL_DESC, VULKAN1_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan1");
}

TEST_F(BackendSelectionTest, VulkanGPUOverIGPUWhenIGPUBack) {
  mockBackend.addDevice(createGPUDevice(INTEL_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createIGPUDevice(INTEL_DESC, VULKAN1_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, NoGPUBackendsPreferredGPUGoesToCPU) {
  expectChosen(mockBackend, BackendType::CPU, "none");
}

TEST_F(BackendSelectionTest, PreferredCPUAlwaysReturnsCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::CPU, "none");
}

TEST_F(BackendSelectionTest, RpcBackendIsEligible) {
  mockBackend.addDevice(
      MockDevice("remote", "RPC0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  expectChosen(mockBackend, BackendType::GPU, "rpc0");
}

TEST_F(BackendSelectionTest, CudaBackendIsEligible) {
  mockBackend.addDevice(MockDevice(
      "NVIDIA RTX 4090", "CUDA0", GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA"));
  expectChosen(mockBackend, BackendType::GPU, "cuda0");
}

TEST_F(BackendSelectionTest, MultipleAdrenoOpenCLChoosesFirst) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl");
}

TEST_F(BackendSelectionTest, MetalGPUShouldBeChosenOverCPU) {
  mockBackend.addDevice(createGPUDevice("apple m1", "metal"));
  mockBackend.addDevice(createACCELDevice("accelerate", "blas"));
  mockBackend.addDevice(createCPUDevice("apple m1", "cpu"));
  expectChosen(mockBackend, BackendType::GPU, "metal");
}

TEST_F(BackendSelectionTest, RocmBeforeVulkanChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "ROCm0"));
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, RocmAfterVulkanChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "hip0"));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, IntegratedRocmIsExcluded) {
  mockBackend.addDevice(createIGPUDevice("AMD Radeon", "ROCm0"));
  mockBackend.addDevice(createIGPUDevice("Android GPU", VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, RocmOnlyFallsBackToCpu) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "ROCm0"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
  EXPECT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& entry) {
    return entry.first == GGML_LOG_LEVEL_WARN &&
           entry.second.find("ROCm0 (standard)") != std::string::npos;
  }));
}

TEST_F(BackendSelectionTest, UnknownGpuFallsBackToCpu) {
  mockBackend.addDevice(createIGPUDevice("Future GPU", "FutureBackend0"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
}

TEST_F(BackendSelectionTest, MtlDeviceIsEligibleCaseInsensitively) {
  mockBackend.addDevice(createIGPUDevice("Apple M3", "MtL0"));
  expectChosen(mockBackend, BackendType::GPU, "mtl0");
}

TEST_F(BackendSelectionTest, MainGpuIndexTargetingRocmFallsBackToCpu) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "ROCm0"));
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  MainGpu mainGpu = 0;
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", mainGpu);
}

TEST_F(BackendSelectionTest, MainGpuIntegratedWarnsAboutRefusedDiscreteGpu) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "ROCm0"));
  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", mainGpu);
  EXPECT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& entry) {
    return entry.first == GGML_LOG_LEVEL_WARN &&
           entry.second.find("ROCm0 (standard)") != std::string::npos;
  }));
}

TEST_F(BackendSelectionTest, MainGpuDedicatedWarnsAboutRefusedIntegratedGpu) {
  mockBackend.addDevice(createIGPUDevice("AMD Radeon", "ROCm0"));
  MainGpu mainGpu = MainGpuType::Dedicated;
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", mainGpu);
  EXPECT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& entry) {
    return entry.first == GGML_LOG_LEVEL_WARN &&
           entry.second.find("ROCm0 (standard)") != std::string::npos;
  }));
}

TEST_F(BackendSelectionTest, RegistryFamilyNamesRequireExactIdentity) {
  mockBackend.addDevice(MockDevice(
      "Future GPU", "Future0", GGML_BACKEND_DEVICE_TYPE_GPU, "NotVulkan"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
}

TEST_F(BackendSelectionTest, RegistryIdentityCanAdmitKnownFamily) {
  for (const std::string registry : {"Vulkan", "MTL", "OpenCL"}) {
    mockBackend.clearDevices();
    mockBackend.addDevice(MockDevice(
        registry == "OpenCL" ? ADRENO_DESC : "Known GPU",
        "driver-device-0",
        GGML_BACKEND_DEVICE_TYPE_GPU,
        std::string(registry)));
    expectChosen(mockBackend, BackendType::GPU, "driver-device-0");
  }
}

// An Adreno OpenCL device identified only by its REGISTRY name must land in the
// OpenCL-priority bucket, which outranks a plain Vulkan GPU enumerated first.
// Classifying it by device name instead puts it in the generic GPU bucket and
// the Vulkan device wins.
TEST_F(BackendSelectionTest, RegistryOnlyOpenClOutranksEarlierVulkan) {
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  mockBackend.addDevice(MockDevice(
      ADRENO_DESC, "driver-device-0", GGML_BACKEND_DEVICE_TYPE_GPU, "OpenCL"));
  expectChosen(mockBackend, BackendType::GPU, "driver-device-0");
}

// OpenCL is the escape hatch that survives the main-gpu device-type filter, so
// an `integrated` request must still select a GPU-typed OpenCL device. That
// only holds if the OpenCL test consults the registry name as well.
TEST_F(BackendSelectionTest, RegistryOnlyOpenClSurvivesMainGpuTypeFilter) {
  mockBackend.addDevice(MockDevice(
      ADRENO_DESC, "driver-device-0", GGML_BACKEND_DEVICE_TYPE_GPU, "OpenCL"));
  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosen(mockBackend, BackendType::GPU, "driver-device-0", mainGpu);
}

TEST_F(BackendSelectionTest, DeviceFamilyNamesRequireKnownPrefixes) {
  mockBackend.addDevice(MockDevice(
      "Future GPU", "NotVulkan0", GGML_BACKEND_DEVICE_TYPE_GPU, "Future"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
}

// MUSA is not an allowlisted family, named either on the device or on the
// registry it came from, so a MUSA-only machine falls back to CPU.
TEST_F(BackendSelectionTest, MusaDeviceIsRejected) {
  mockBackend.addDevice(createGPUDevice("Moore Threads MTT S80", "MUSA0"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");

  mockBackend.clearDevices();
  mockBackend.addDevice(MockDevice(
      "Moore Threads MTT S80",
      "mtt-device-0",
      GGML_BACKEND_DEVICE_TYPE_GPU,
      "MUSA"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
}

// An unknown family behind an eligible device must not be picked up as a
// fallback: Vulkan0 is still chosen.
TEST_F(BackendSelectionTest, UnknownGpuAfterVulkanChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice("Future GPU", "FutureBackend0"));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, TryMainGpuFromMapWithInteger) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "0";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<int>(result.value()));
  EXPECT_EQ(std::get<int>(result.value()), 0);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

TEST_F(BackendSelectionTest, TryMainGpuFromMapWithIntegerOne) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "1";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<int>(result.value()));
  EXPECT_EQ(std::get<int>(result.value()), 1);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

TEST_F(BackendSelectionTest, TryMainGpuFromMapWithIntegrated) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "integrated";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Integrated);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

TEST_F(BackendSelectionTest, TryMainGpuFromMapWithDedicated) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "dedicated";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Dedicated);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

TEST_F(BackendSelectionTest, TryMainGpuFromMapWithIntegratedCaseInsensitive) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "INTEGRATED";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Integrated);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

TEST_F(BackendSelectionTest, TryMainGpuFromMapWithDedicatedCaseInsensitive) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "DEDICATED";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Dedicated);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

TEST_F(BackendSelectionTest, TryMainGpuFromMapWhenKeyNotPresent) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["other-key"] = "value";

  auto result = tryMainGpuFromMap(configFilemap);

  EXPECT_FALSE(result.has_value());
  EXPECT_EQ(configFilemap.size(), 1);
  EXPECT_NE(configFilemap.find("other-key"), configFilemap.end());
}

TEST_F(BackendSelectionTest, TryMainGpuFromMapWithEmptyMap) {
  std::unordered_map<std::string, std::string> configFilemap;

  auto result = tryMainGpuFromMap(configFilemap);

  EXPECT_FALSE(result.has_value());
  EXPECT_TRUE(configFilemap.empty());
}

// Test tryMainGpuFromMap with underscore variant "main_gpu"
TEST_F(BackendSelectionTest, TryMainGpuFromMapAcceptsUnderscoreVariant) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main_gpu"] = "0";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<int>(result.value()));
  EXPECT_EQ(std::get<int>(result.value()), 0);
  EXPECT_TRUE(configFilemap.empty());
}

// Test tryMainGpuFromMap rejects both "main-gpu" and "main_gpu" present
TEST_F(BackendSelectionTest, TryMainGpuFromMapRejectsBothVariants) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "1";
  configFilemap["main_gpu"] = "0";

  EXPECT_THROW(tryMainGpuFromMap(configFilemap), qvac_errors::StatusError);
}

TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegerIndex) {
  mockBackend.addDevice(createIGPUDevice(INTEL_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(INTEL_DESC, VULKAN1_BACK));

  MainGpu mainGpu = 0;
  expectChosen(mockBackend, BackendType::GPU, "vulkan0", mainGpu);
}

TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegrated) {
  mockBackend.addDevice(createIGPUDevice(INTEL_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(INTEL_DESC, VULKAN1_BACK));

  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosen(mockBackend, BackendType::GPU, "vulkan0", mainGpu);
}

TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuDedicated) {
  mockBackend.addDevice(createIGPUDevice(INTEL_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(INTEL_DESC, VULKAN1_BACK));

  MainGpu mainGpu = MainGpuType::Dedicated;
  expectChosen(mockBackend, BackendType::GPU, "vulkan1", mainGpu);
}

TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegerIndexOne) {
  mockBackend.addDevice(createIGPUDevice(INTEL_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(INTEL_DESC, VULKAN1_BACK));

  MainGpu mainGpu = 1;
  expectChosen(mockBackend, BackendType::GPU, "vulkan1", mainGpu);
}

TEST_F(BackendSelectionTest, PreferredBackendTypeFromStringGpu) {
  BackendType result = preferredBackendTypeFromString("gpu");
  EXPECT_EQ(result, BackendType::GPU);
}

TEST_F(BackendSelectionTest, PreferredBackendTypeFromStringCpu) {
  BackendType result = preferredBackendTypeFromString("cpu");
  EXPECT_EQ(result, BackendType::CPU);
}

TEST_F(BackendSelectionTest, PreferredBackendTypeFromStringInvalid) {
  EXPECT_THROW(
      { preferredBackendTypeFromString("invalid"); }, qvac_errors::StatusError);
}

TEST_F(BackendSelectionTest, ParseMainGpuEmpty) {
  auto result = parseMainGpu("");
  EXPECT_FALSE(result.has_value());
}

TEST_F(BackendSelectionTest, ParseMainGpuInteger) {
  auto result = parseMainGpu("2");
  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<int>(result.value()));
  EXPECT_EQ(std::get<int>(result.value()), 2);
}

TEST_F(BackendSelectionTest, ParseMainGpuIntegrated) {
  auto result = parseMainGpu("integrated");
  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Integrated);
}

TEST_F(BackendSelectionTest, ParseMainGpuDedicated) {
  auto result = parseMainGpu("dedicated");
  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Dedicated);
}

TEST_F(BackendSelectionTest, ParseMainGpuInvalid) {
  EXPECT_THROW({ parseMainGpu("invalid"); }, qvac_errors::StatusError);
}

// ---- getEffectiveGpuDeviceCount ----

TEST_F(BackendSelectionTest, GpuCount_NoDevices_ReturnsZero) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 0u);
}

TEST_F(BackendSelectionTest, GpuCount_OnlyCpu_ReturnsZero) {
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 0u);
}

TEST_F(BackendSelectionTest, GpuCount_SingleDgpu_ReturnsOne) {
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 1u);
}

TEST_F(BackendSelectionTest, GpuCount_SingleIgpu_ReturnsOne) {
  mockBackend.addDevice(createIGPUDevice("intel uhd 770", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 1u);
}

TEST_F(BackendSelectionTest, GpuCount_TwoDgpus_ReturnsTwo) {
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN1_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 2u);
}

TEST_F(BackendSelectionTest, GpuCount_DgpuPlusIgpu_ReturnsOnlyDgpuCount) {
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4060", VULKAN0_BACK));
  mockBackend.addDevice(createIGPUDevice("intel uhd 770", VULKAN1_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 1u);
}

TEST_F(BackendSelectionTest, GpuCount_TwoDgpusPlusIgpu_ReturnsDgpuCount) {
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN1_BACK));
  mockBackend.addDevice(createIGPUDevice("intel uhd 770", "Vulkan2"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 2u);
}

TEST_F(BackendSelectionTest, GpuCount_TwoIgpusUsesFirstFabricDevice) {
  mockBackend.addDevice(createIGPUDevice("intel uhd 770", VULKAN0_BACK));
  mockBackend.addDevice(createIGPUDevice("intel iris xe", VULKAN1_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 1u);
}

TEST_F(BackendSelectionTest, GpuCount_AccelAndCpuIgnored) {
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN0_BACK));
  mockBackend.addDevice(createACCELDevice("accelerate", "blas"));
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 1u);
}

TEST_F(BackendSelectionTest, GpuCount_UnsupportedBackendsIgnored) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "ROCm0"));
  mockBackend.addDevice(createIGPUDevice("Future GPU", "FutureBackend0"));
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 1u);
}

TEST_F(BackendSelectionTest, GpuCount_CudaAndRpcAreEligible) {
  mockBackend.addDevice(MockDevice(
      "NVIDIA RTX 4090", "CUDA0", GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA"));
  mockBackend.addDevice(
      MockDevice("remote", "RPC0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 2u);
}

TEST_F(BackendSelectionTest, SplitDevicesIncludeCudaAndRpc) {
  mockBackend.addDevice(MockDevice(
      "NVIDIA RTX 4090", "CUDA0", GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA"));
  mockBackend.addDevice(
      MockDevice("remote", "RPC0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI), (std::vector<std::string>{"RPC0", "CUDA0"}));
}

TEST_F(BackendSelectionTest, RpcDoesNotSuppressLocalIntegratedGpu) {
  mockBackend.addDevice(
      MockDevice("remote", "RPC0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  mockBackend.addDevice(createIGPUDevice("Apple M3", "MTL0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI), (std::vector<std::string>{"RPC0", "MTL0"}));
}

// The same card reported by two backends carries one PCI id byte for byte, so
// the registry-order first entry wins, as in fabric.
TEST_F(BackendSelectionTest, CudaAndVulkanSamePciIdKeepsRegistryFirst) {
  mockBackend.addDevice(withDeviceId(
      MockDevice(
          "NVIDIA RTX 4090", "CUDA0", GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA"),
      "0000:01:00.0"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK), "0000:01:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"CUDA0"}));
}

// Fabric compares raw ids with strcmp, so CUDA virtual (MPS/MIG) devices are
// distinct devices and both stay in the split set.
TEST_F(BackendSelectionTest, CudaVirtualDeviceIdsAreKeptDistinct) {
  mockBackend.addDevice(withDeviceId(
      MockDevice(
          "NVIDIA RTX 4090", "CUDA0", GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA"),
      "0000:01:00.0-v0"));
  mockBackend.addDevice(withDeviceId(
      MockDevice(
          "NVIDIA RTX 4090", "CUDA1", GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA"),
      "0000:01:00.0-v1"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI), (std::vector<std::string>{"CUDA0", "CUDA1"}));
}

TEST_F(BackendSelectionTest, SplitDeviceSelectionPreservesSourceGpuIndices) {
  mockBackend.addDevice(MockDevice(
      "NVIDIA RTX 4090", "CUDA0", GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA"));
  mockBackend.addDevice(
      MockDevice("AMD Radeon", "ROCm0", GGML_BACKEND_DEVICE_TYPE_GPU, "HIP"));
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  const SplitDeviceSelection selection = getSplitDeviceSelection(bckI);
  ASSERT_EQ(selection.devices.size(), 2U);
  EXPECT_EQ(selection.sourceGpuCount, 3U);
  EXPECT_EQ(selection.devices[0].sourceGpuIndex, 0U);
  EXPECT_EQ(selection.devices[1].sourceGpuIndex, 2U);
}

TEST_F(BackendSelectionTest, SplitDeviceSelectionMarksRpcDevices) {
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  mockBackend.addDevice(
      MockDevice("remote", "RPC0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  const SplitDeviceSelection selection = getSplitDeviceSelection(bckI);
  ASSERT_EQ(selection.devices.size(), 2U);
  EXPECT_EQ(selection.devices[0].name, "RPC0");
  EXPECT_TRUE(selection.devices[0].isRpc);
  EXPECT_EQ(selection.devices[1].name, "Vulkan0");
  EXPECT_FALSE(selection.devices[1].isRpc);
}

TEST_F(BackendSelectionTest, SplitDevicesExcludeUnsupportedBackends) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "ROCm0"));
  mockBackend.addDevice(createGPUDevice("Intel Arc", "SYCL0"));
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"Vulkan0"}));
}

// Pins a deliberate divergence from fabric 10549, which keeps every additional
// iGPU sharing the first one's registry. Embed keeps at most one. Changing this
// means revisiting that decision, not fixing a bug -- see the comment in
// getSplitDeviceSelection.
TEST_F(BackendSelectionTest, SplitDevicesKeepOnlyOneIntegratedGpu) {
  mockBackend.addDevice(MockDevice(
      "Intel Iris Xe", "Vulkan0", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan"));
  mockBackend.addDevice(MockDevice(
      "Intel Iris Xe", "Vulkan1", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"Vulkan0"}));
}

TEST_F(BackendSelectionTest, SplitDevicesPreferDiscreteAndDedupeByDeviceId) {
  mockBackend.addDevice(createIGPUDevice("Apple M3", "MTL0"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK), "0000:01:00.0"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA RTX 4090", VULKAN1_BACK), "0000:01:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"Vulkan0"}));
}

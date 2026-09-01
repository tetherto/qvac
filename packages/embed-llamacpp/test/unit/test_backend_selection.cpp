#include <algorithm>
#include <cctype>
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
  /// Whether this device's backend registry exposes
  /// `ggml_backend_split_buffer_type`, i.e. whether it can do row-split. Only
  /// SYCL does as of qvac-fabric v10069, so this defaults to false.
  bool hasSplitBuffers = false;
  /// PCI bus id as `props.device_id`, empty for a backend that publishes none.
  std::string deviceId;

  MockDevice(
      std::string&& desc, std::string&& backend,
      enum ggml_backend_dev_type devType, std::string&& reg = "standard")
      : description(std::move(desc)), backend_name(std::move(backend)),
        regName(std::move(reg)), type(devType) {}
};

static MockDevice withSplitBuffers(MockDevice device) {
  device.hasSplitBuffers = true;
  return device;
}

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
  mutable std::vector<std::string> string_storage;

  static thread_local MockBackendInterface* currentInstance;

  void addDevice(const MockDevice& device) { devices.push_back(device); }

  void clearDevices() {
    devices.clear();
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
        &MockBackendInterface::static_reg_get_proc_address,
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

  // `static_dev_backend_reg` hands back the device pointer as the registry
  // handle, so recover the MockDevice from it to answer per-device.
  static void*
  static_reg_get_proc_address(ggml_backend_reg_t reg, const char* name) {
    if (currentInstance == nullptr || reg == nullptr || name == nullptr) {
      return nullptr;
    }
    MockDevice* dev = reinterpret_cast<MockDevice*>(reg);
    if (dev->hasSplitBuffers &&
        std::string(name) == "ggml_backend_split_buffer_type") {
      // Callers only test the address for presence, so any non-null will do.
      return reinterpret_cast<void*>(dev);
    }
    return nullptr;
  }

  // Only `device_id` is read by the code under test; a device with no id
  // leaves it null, which is how a backend without VK_EXT_pci_bus_info reports.
  static void
  static_dev_get_props(ggml_backend_dev_t dev, ggml_backend_dev_props* props) {
    if (props == nullptr) {
      return;
    }
    *props = {};
    if (currentInstance == nullptr || dev == nullptr) {
      return;
    }
    MockDevice* mock_dev = reinterpret_cast<MockDevice*>(dev);
    props->type = mock_dev->type;
    if (!mock_dev->deviceId.empty()) {
      currentInstance->string_storage.push_back(mock_dev->deviceId);
      props->device_id = currentInstance->string_storage.back().c_str();
    }
  }

  static void static_llamaLogCallback(
      ggml_log_level level, const char* text, void* userData) {
    (void)level;
    (void)userData;
    (void)text;
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

TEST_F(BackendSelectionTest, RPCBackendIsIgnored) {
  mockBackend.addDevice(
      MockDevice("Adreno 840", "OpenCL", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
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

TEST_F(BackendSelectionTest, GpuCount_TwoIgpus_ReturnsTwo) {
  mockBackend.addDevice(createIGPUDevice("intel uhd 770", VULKAN0_BACK));
  mockBackend.addDevice(createIGPUDevice("intel iris xe", VULKAN1_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 2u);
}

TEST_F(BackendSelectionTest, GpuCount_AccelAndCpuIgnored) {
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN0_BACK));
  mockBackend.addDevice(createACCELDevice("accelerate", "blas"));
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getEffectiveGpuDeviceCount(bckI), 1u);
}

// ---- gpuBackendSupportsRowSplit ----
//
// qvac-fabric builds a split buffer list for EVERY device it distributes over
// and throws on the first one whose backend lacks split buffers, so the
// predicate must require all of them rather than any one. `withSplitBuffers()`
// marks a mock device as SYCL-like (registry exposes
// `ggml_backend_split_buffer_type`); plain devices are Vulkan/Metal/OpenCL-like
// and expose nothing, which is every backend shipped at qvac-fabric v10069.

TEST_F(BackendSelectionTest, RowSplit_NoDevices_ReturnsFalse) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_FALSE(gpuBackendSupportsRowSplit(bckI));
}

TEST_F(BackendSelectionTest, RowSplit_OnlyCpu_ReturnsFalse) {
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_FALSE(gpuBackendSupportsRowSplit(bckI));
}

TEST_F(BackendSelectionTest, RowSplit_SingleGpuWithoutSplitBuffers_False) {
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_FALSE(gpuBackendSupportsRowSplit(bckI));
}

TEST_F(BackendSelectionTest, RowSplit_SingleGpuWithSplitBuffers_True) {
  mockBackend.addDevice(
      withSplitBuffers(createGPUDevice("intel arc a770", "SYCL0")));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_TRUE(gpuBackendSupportsRowSplit(bckI));
}

TEST_F(BackendSelectionTest, RowSplit_AllGpusWithSplitBuffers_True) {
  mockBackend.addDevice(
      withSplitBuffers(createGPUDevice("intel arc a770", "SYCL0")));
  mockBackend.addDevice(
      withSplitBuffers(createGPUDevice("intel arc a770", "SYCL1")));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_TRUE(gpuBackendSupportsRowSplit(bckI));
}

// The all-vs-any pin: one unsupported backend registered alongside a supported
// one is enough for qvac-fabric to reject the load, so the answer is false.
TEST_F(BackendSelectionTest, RowSplit_OneGpuMissingSplitBuffers_False) {
  mockBackend.addDevice(
      withSplitBuffers(createGPUDevice("intel arc a770", "SYCL0")));
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_FALSE(gpuBackendSupportsRowSplit(bckI));
}

// Same for an iGPU enumerated alongside a supported discrete GPU: it is still a
// device qvac-fabric will try to build a split buffer for.
TEST_F(BackendSelectionTest, RowSplit_IgpuMissingSplitBuffers_False) {
  mockBackend.addDevice(
      withSplitBuffers(createGPUDevice("intel arc a770", "SYCL0")));
  mockBackend.addDevice(createIGPUDevice("intel uhd 770", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_FALSE(gpuBackendSupportsRowSplit(bckI));
}

TEST_F(BackendSelectionTest, RowSplit_AccelAndCpuIgnored_True) {
  mockBackend.addDevice(
      withSplitBuffers(createGPUDevice("intel arc a770", "SYCL0")));
  mockBackend.addDevice(createACCELDevice("accelerate", "blas"));
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_TRUE(gpuBackendSupportsRowSplit(bckI));
}

// ---- QVAC-23763: CUDA prioritisation and the `backend` override ----

// GPU backend names as ggml reports them. ggml-cuda uses "CUDA%d"; ggml-hip
// uses "ROCm%d", which is why CUDA detection cannot pick up an AMD device.
constexpr const char* CUDA0_BACK = "CUDA0";
constexpr const char* CUDA1_BACK = "CUDA1";
constexpr const char* ROCM0_BACK = "ROCm0";
constexpr const char* NVIDIA_DESC = "NVIDIA GeForce RTX 3090";
constexpr const char* TESLA_DESC = "Tesla T4";

std::pair<BackendType, std::string> chooseWithOverride(
    MockBackendInterface& mockBackend,
    const std::vector<std::string>& backendOverride,
    BackendType preferred = BackendType::GPU) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  return chooseBackend(preferred, bckI, std::nullopt, backendOverride);
}

// The headline behaviour: on a host where the same physical GPU registers
// under both backends, CUDA wins.
TEST_F(BackendSelectionTest, CudaPreferredOverVulkan) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "cuda0");
}

// Registration order must not decide the outcome. This is the whole reason the
// preference is stated rather than inherited from ggml's load order.
TEST_F(BackendSelectionTest, CudaPreferredOverVulkanRegardlessOfDeviceOrder) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "cuda0");
}

// No CUDA module or no NVIDIA driver: the device never registers, so the
// cascade lands on Vulkan with no special handling.
TEST_F(BackendSelectionTest, VulkanChosenWhenNoCudaDevice) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

// A discrete CUDA GPU must still beat an integrated GPU.
TEST_F(BackendSelectionTest, CudaPreferredOverIntegratedGpu) {
  mockBackend.addDevice(createIGPUDevice(INTEL_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, CUDA0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "cuda0");
}

// Adreno OpenCL must keep winning: mobile behaviour is unchanged by CUDA.
TEST_F(BackendSelectionTest, AdrenoOpenClStillBeatsCuda) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, CUDA0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl");
}

// "ROCm0" must not be mistaken for a CUDA device.
TEST_F(BackendSelectionTest, RocmIsNotTreatedAsCuda) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon 8060S", ROCM0_BACK));
  mockBackend.addDevice(createGPUDevice("AMD Radeon 8060S", VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "rocm0");
}

TEST_F(BackendSelectionTest, OverrideVulkanBeatsPresentCuda) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  auto result = chooseWithOverride(mockBackend, {"vulkan", "cuda"});
  expectChosen(result, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, OverrideRespectsListOrder) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  auto result = chooseWithOverride(mockBackend, {"cuda", "vulkan"});
  expectChosen(result, BackendType::GPU, "cuda0");
}

// A correctly spelled backend with no device on this machine is not a config
// error, so selection continues down the list and then the normal cascade.
TEST_F(BackendSelectionTest, OverrideSkipsAbsentBackend) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, VULKAN0_BACK));
  auto result = chooseWithOverride(mockBackend, {"cuda", "vulkan"});
  expectChosen(result, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, OverrideFallsThroughWhenNothingMatches) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, VULKAN0_BACK));
  auto result = chooseWithOverride(mockBackend, {"cuda"});
  expectChosen(result, BackendType::GPU, "vulkan0");
}

// device 'cpu' with a backend override must land on CPU quietly: no devices are
// enumerated, so the override has nothing to match and must not be an error.
TEST_F(BackendSelectionTest, OverrideIgnoredWhenPreferredCpu) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, CUDA0_BACK));
  auto result = chooseWithOverride(mockBackend, {"cuda"}, BackendType::CPU);
  EXPECT_EQ(result.first, BackendType::CPU);
  EXPECT_EQ(result.second, "none");
}

TEST_F(BackendSelectionTest, ParseBackendOverrideLowercasesAndSplits) {
  EXPECT_EQ(
      parseBackendOverride("CUDA,Vulkan"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST_F(BackendSelectionTest, ParseBackendOverrideTrimsSpaces) {
  EXPECT_EQ(
      parseBackendOverride(" cuda , vulkan "),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST_F(BackendSelectionTest, ParseBackendOverrideDropsDuplicates) {
  EXPECT_EQ(
      parseBackendOverride("cuda,cuda,vulkan"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST_F(BackendSelectionTest, ParseBackendOverrideIgnoresEmptyEntries) {
  EXPECT_EQ(
      parseBackendOverride("cuda,,vulkan,"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

// A misspelled name IS a config error, unlike an absent device.
TEST_F(BackendSelectionTest, ParseBackendOverrideThrowsOnUnknownName) {
  EXPECT_THROW(parseBackendOverride("cudaa"), qvac_errors::StatusError);
}

// 'cpu' is deliberately not a backend name: the CPU path is `device`.
TEST_F(BackendSelectionTest, ParseBackendOverrideRejectsCpu) {
  EXPECT_THROW(parseBackendOverride("cpu"), qvac_errors::StatusError);
}

// ggml's HIP build reports its devices as "ROCm%d", so 'hip' has to arrive at
// the matcher as "rocm" or it pins nothing.
TEST_F(BackendSelectionTest, ParseBackendOverrideCanonicalisesHipToRocm) {
  EXPECT_EQ(parseBackendOverride("hip"), (std::vector<std::string>{"rocm"}));
  EXPECT_EQ(
      parseBackendOverride("hip,rocm"), (std::vector<std::string>{"rocm"}));
}

// A blank value means the key was not configured, but a value made only of
// separators is a mistake and must be as loud as a misspelled name.
TEST_F(BackendSelectionTest, ParseBackendOverrideRejectsAValueNamingNothing) {
  EXPECT_THROW(parseBackendOverride(","), qvac_errors::StatusError);
  EXPECT_TRUE(parseBackendOverride("   ").empty());
}

// A non-Adreno OpenCL device is kept out of the default cascade, which is
// Adreno-tuned, so the default pick is unchanged.
TEST_F(BackendSelectionTest, NonAdrenoOpenClNotChosenByDefault) {
  mockBackend.addDevice(createGPUDevice("Intel Arc A770", OPENCL_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(BackendType::GPU, bckI);
  EXPECT_EQ(result.first, BackendType::CPU);
}

// But an explicit request must still reach it, otherwise 'opencl' is an
// accepted family that matches nothing on an Intel or AMD host.
TEST_F(BackendSelectionTest, OverrideReachesNonAdrenoOpenCl) {
  mockBackend.addDevice(createGPUDevice("Intel Arc A770", OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice("Intel Arc A770", VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
  auto result = chooseWithOverride(mockBackend, {"opencl"});
  expectChosen(result, BackendType::GPU, "gpuopencl");
}

// 'auto' is vla-ggml's spelling for "no preference" on this same key, so one
// selector string stays valid across all three addons.
TEST_F(BackendSelectionTest, ParseBackendOverrideAcceptsAutoAsNoPreference) {
  EXPECT_TRUE(parseBackendOverride("auto").empty());
  EXPECT_TRUE(parseBackendOverride(" AUTO ").empty());
}

TEST_F(BackendSelectionTest, ParseBackendOverrideDropsAutoFromAList) {
  EXPECT_EQ(
      parseBackendOverride("auto,cuda"), (std::vector<std::string>{"cuda"}));
}

// A CRLF config file would otherwise throw on a value that reads as correct,
// because the offending byte does not render in the error message.
TEST_F(BackendSelectionTest, ParseBackendOverrideTrimsCarriageReturns) {
  EXPECT_EQ(
      parseBackendOverride("cuda\r\n,\tvulkan\r"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

// Accepting 'auto' must not weaken this: a value naming nothing at all is
// still a config mistake.
TEST_F(BackendSelectionTest, ParseBackendOverrideStillRejectsSeparatorsOnly) {
  EXPECT_THROW(parseBackendOverride(","), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride(" , "), qvac_errors::StatusError);
}

// Blank stays "key not configured", not an error.
TEST_F(BackendSelectionTest, ParseBackendOverrideBlankIsEmptyList) {
  EXPECT_TRUE(parseBackendOverride("\r\n").empty());
}

TEST_F(BackendSelectionTest, TryBackendOverrideFromMapErasesKey) {
  std::unordered_map<std::string, std::string> config{
      {"device", "gpu"}, {"backend", "cuda,vulkan"}};
  EXPECT_EQ(
      tryBackendOverrideFromMap(config),
      (std::vector<std::string>{"cuda", "vulkan"}));
  EXPECT_EQ(config.count("backend"), 0u);
  EXPECT_EQ(config.count("device"), 1u);
}

TEST_F(BackendSelectionTest, TryBackendOverrideFromMapAbsentIsEmpty) {
  std::unordered_map<std::string, std::string> config{{"device", "gpu"}};
  EXPECT_TRUE(tryBackendOverrideFromMap(config).empty());
}

// ---- QVAC-23763: split-mode device scoping ----
//
// Grouping is by backend REGISTRY name, not by device name, so these fixtures
// set it explicitly. createGPUDevice() leaves it at the mock default, which
// puts every device in one registry.

constexpr const char* CUDA_REG = "CUDA";
constexpr const char* VULKAN_REG = "Vulkan";

static MockDevice createGPUDeviceInRegistry(
    std::string&& desc, std::string&& backend, std::string&& registry) {
  return {
      std::move(desc),
      std::move(backend),
      GGML_BACKEND_DEVICE_TYPE_GPU,
      std::move(registry)};
}

static std::vector<std::string> splitDevicesFor(
    MockBackendInterface& mockBackend, const std::string& selected) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  return splitModeDeviceNames(bckI, selected);
}

// Every pre-CUDA host: one registry, so --device keeps being omitted and
// qvac-fabric enumerates the GPUs itself exactly as before.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesEmptyOnSingleRegistry) {
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN1_BACK, VULKAN_REG));
  EXPECT_TRUE(splitDevicesFor(mockBackend, "vulkan0").empty());
}

TEST_F(BackendSelectionTest, SplitModeDeviceNamesEmptyWithNoGpuAtAll) {
  mockBackend.addDevice(createCPUDevice("host", "CPU"));
  EXPECT_TRUE(splitDevicesFor(mockBackend, "cuda0").empty());
}

// The case this exists for: two NVIDIA cards, each registered twice. Without
// scoping, split mode would hand qvac-fabric four devices for two GPUs.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesScopesToSelectedRegistry) {
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA1_BACK, CUDA_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN1_BACK, VULKAN_REG));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "cuda0"),
      (std::vector<std::string>{"cuda0", "cuda1"}));
}

// An explicit backend override lands on Vulkan; the split must follow it rather
// than the default CUDA preference.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesFollowsTheChosenBackend) {
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN1_BACK, VULKAN_REG));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "vulkan0"),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

// An iGPU must NOT join a split that already has a discrete GPU.
// llama_prepare_model_devices() drops iGPUs whenever it found any discrete GPU,
// but only on the path where --device is absent; with --device set it takes
// every name verbatim. Keeping the iGPU here would put layers on an Intel UHD
// beside a 3090, which qvac-fabric would never have done on its own.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesDropsIgpuBesideDiscreteGpu) {
  MockDevice igpu(
      "intel arc", "Vulkan1", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan");
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  mockBackend.addDevice(std::move(igpu));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "vulkan0"),
      (std::vector<std::string>{"vulkan0"}));
}

// `main-gpu: 'integrated'` deliberately selects the iGPU. Scope the split to it
// rather than pulling back in the discrete cards the caller just excluded.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesScopesToADeliberateIgpu) {
  MockDevice igpu(
      "intel arc", "Vulkan1", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan");
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  mockBackend.addDevice(std::move(igpu));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "vulkan1"),
      (std::vector<std::string>{"vulkan1"}));
}

// A name that matches nothing degrades to the old omit-everything behaviour
// rather than to an empty device list, which would strand the load on no GPU.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesEmptyWhenSelectionUnmatched) {
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  EXPECT_TRUE(splitDevicesFor(mockBackend, "metal0").empty());
}

constexpr const char* AMD_DESC = "AMD Radeon RX 7900 XTX";
constexpr const char* BUS_A = "0000:01:00.0";
constexpr const char* BUS_B = "0000:02:00.0";
constexpr const char* BUS_C = "0000:03:00.0";

// One physical card publishing the same bus id under both backends is named
// once, which is the whole reason --device is passed in split mode.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesDedupesOneCardAcrossRegistry) {
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG), BUS_A));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG), BUS_A));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "cuda0"),
      (std::vector<std::string>{"cuda0"}));
}

// The regression scoping by registry introduced: a discrete second card from
// another vendor is not registered under CUDA, so filtering to the selected
// registry dropped it and left a two-entry tensor-split on one device.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesKeepsAnotherVendorsCard) {
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG), BUS_A));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG), BUS_A));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(AMD_DESC, VULKAN1_BACK, VULKAN_REG), BUS_B));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "cuda0"),
      (std::vector<std::string>{"cuda0", "vulkan1"}));
}

// Two NVIDIA cards plus a discrete AMD: each NVIDIA collapses to its CUDA
// entry, the AMD survives on Vulkan, and ggml's enumeration order is kept.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesDedupesAcrossMixedVendorHost) {
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG), BUS_A));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA1_BACK, CUDA_REG), BUS_B));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG), BUS_A));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN1_BACK, VULKAN_REG), BUS_B));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(AMD_DESC, "Vulkan2", VULKAN_REG), BUS_C));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "cuda0"),
      (std::vector<std::string>{"cuda0", "cuda1", "vulkan2"}));
}

// A `backend` override selecting Vulkan must keep the Vulkan entry for the
// shared card, not the CUDA one. Omitting --device could not express this:
// qvac-fabric's own dedupe keeps whichever backend registered first, and CUDA
// loads before Vulkan.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesDedupeFollowsChosenBackend) {
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG), BUS_A));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG), BUS_A));
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(AMD_DESC, VULKAN1_BACK, VULKAN_REG), BUS_B));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "vulkan0"),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

// A backend that publishes no bus id cannot be matched against its own
// duplicate, so those devices fall back to the old registry scoping rather than
// risk naming one physical card twice.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesFallsBackWithoutADeviceId) {
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG), BUS_A));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "cuda0"),
      (std::vector<std::string>{"cuda0"}));
}

// The same host with the selection on the other side, which is the direction
// that used to break: `backend: 'vulkan'` on a driver without
// VK_EXT_pci_bus_info leaves the selected registry publishing no id at all, so
// a partial key list disabled the cross-registry skip and named the one card
// twice as cuda0,vulkan0.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesFallsBackWhenSelectedHasNoId) {
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG), BUS_A));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "vulkan0"),
      (std::vector<std::string>{"vulkan0"}));
}

// A second real card must still survive the wholesale fallback, scoped to the
// selected registry, rather than the list collapsing to the one selected name.
TEST_F(
    BackendSelectionTest, SplitModeDeviceNamesFallbackKeepsSelectedRegistry) {
  mockBackend.addDevice(withDeviceId(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG), BUS_A));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, VULKAN0_BACK, VULKAN_REG));
  mockBackend.addDevice(
      createGPUDeviceInRegistry(AMD_DESC, VULKAN1_BACK, VULKAN_REG));
  EXPECT_EQ(
      splitDevicesFor(mockBackend, "vulkan0"),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

// ---- backend-required and main-gpu addressing (QVAC-23763 R11/R13) ----
//
// Mirrors the llm-llamacpp cases. embed has no metadata, finetuning or Adreno
// rules, so the "an override cannot resurrect a guarded device" variants have no
// counterpart here; everything else applies unchanged.

static BackendChoice chooseWithRequired(
    MockBackendInterface& mockBackend,
    const std::vector<std::string>& backendOverride, bool required) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  BackendRequest request;
  request.preferred = BackendType::GPU;
  request.backendOverride = backendOverride;
  request.backendRequired = required;
  return chooseBackend(request, bckI);
}

static BackendChoice chooseWithMainGpu(
    MockBackendInterface& mockBackend, const MainGpu& mainGpu) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  BackendRequest request;
  request.preferred = BackendType::GPU;
  request.mainGpu = mainGpu;
  return chooseBackend(request, bckI);
}

TEST_F(BackendSelectionTest, AdvisoryOverrideStillFallsThrough) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  EXPECT_EQ(chooseWithRequired(mockBackend, {"cuda"}, false).name, "vulkan0");
}

TEST_F(BackendSelectionTest, StrictOverrideThrowsWhenNothingMatches) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  try {
    chooseWithRequired(mockBackend, {"cuda"}, true);
    FAIL() << "expected a StatusError";
  } catch (const qvac_errors::StatusError& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("cuda"), std::string::npos) << what;
    // must name what WAS there, or diagnosing it takes a second run
    EXPECT_NE(what.find("vulkan0"), std::string::npos) << what;
  }
}

TEST_F(BackendSelectionTest, StrictOverrideIsSatisfiedByAMatch) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  EXPECT_EQ(chooseWithRequired(mockBackend, {"vulkan"}, true).name, "vulkan0");
}

TEST_F(BackendSelectionTest, BackendRequiredParsing) {
  for (const char* yes : {"true", "on", "1", "TRUE"}) {
    std::unordered_map<std::string, std::string> cfg{{"backend-required", yes}};
    EXPECT_TRUE(tryBackendRequiredFromMap(cfg, true)) << yes;
    EXPECT_EQ(cfg.count("backend-required"), 0u) << yes;
  }
  for (const char* no : {"false", "off", "0"}) {
    std::unordered_map<std::string, std::string> cfg{{"backend-required", no}};
    EXPECT_FALSE(tryBackendRequiredFromMap(cfg, true)) << no;
  }
  std::unordered_map<std::string, std::string> underscore{
      {"backend_required", "true"}};
  EXPECT_TRUE(tryBackendRequiredFromMap(underscore, true));

  std::unordered_map<std::string, std::string> absent;
  EXPECT_FALSE(tryBackendRequiredFromMap(absent, true));
}

TEST_F(BackendSelectionTest, BackendRequiredRejectsBothSpellings) {
  std::unordered_map<std::string, std::string> cfg{
      {"backend-required", "true"}, {"backend_required", "true"}};
  EXPECT_THROW(tryBackendRequiredFromMap(cfg, true), qvac_errors::StatusError);
}

TEST_F(BackendSelectionTest, BackendRequiredRejectsNonsense) {
  std::unordered_map<std::string, std::string> cfg{{"backend-required", "yes"}};
  EXPECT_THROW(tryBackendRequiredFromMap(cfg, true), qvac_errors::StatusError);
}

TEST_F(BackendSelectionTest, BackendRequiredWithoutBackendThrows) {
  std::unordered_map<std::string, std::string> cfg{
      {"backend-required", "true"}};
  EXPECT_THROW(tryBackendRequiredFromMap(cfg, false), qvac_errors::StatusError);
  std::unordered_map<std::string, std::string> off{
      {"backend-required", "false"}};
  EXPECT_FALSE(tryBackendRequiredFromMap(off, false));
}

TEST_F(BackendSelectionTest, MainGpuIntegerStillWorks) {
  EXPECT_EQ(parseMainGpu("0"), MainGpu(0));
  EXPECT_EQ(parseMainGpu("integrated"), MainGpu(MainGpuType::Integrated));
  EXPECT_EQ(parseMainGpu("dedicated"), MainGpu(MainGpuType::Dedicated));
  EXPECT_EQ(parseMainGpu(""), std::nullopt);
}

// std::stoi parsed a leading prefix and threw the rest away, which is what made
// a bus id parse as device 0.
TEST_F(BackendSelectionTest, MainGpuRejectsPartialIntegerParse) {
  EXPECT_THROW(parseMainGpu("1abc"), qvac_errors::StatusError);
  EXPECT_THROW(parseMainGpu("nonsense"), qvac_errors::StatusError);
}

TEST_F(BackendSelectionTest, MainGpuBusIdNotMisparsedAsZero) {
  const auto parsed = parseMainGpu("0000:65:00.0");
  ASSERT_TRUE(parsed.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuBusId>(parsed.value()));
  EXPECT_EQ(std::get<MainGpuBusId>(parsed.value()).id, "0000:65:00.0");
}

TEST_F(BackendSelectionTest, MainGpuQualifiedParsing) {
  const auto parsed = parseMainGpu("CUDA:1");
  ASSERT_TRUE(parsed.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuQualified>(parsed.value()));
  EXPECT_EQ(std::get<MainGpuQualified>(parsed.value()).family, "cuda");
  EXPECT_EQ(std::get<MainGpuQualified>(parsed.value()).index, 1);
  EXPECT_EQ(
      std::get<MainGpuQualified>(parseMainGpu("hip:0").value()).family, "rocm");
}

TEST_F(BackendSelectionTest, MainGpuQualifiedRejectsUnknownFamily) {
  EXPECT_THROW(parseMainGpu("nvidia:0"), qvac_errors::StatusError);
}

TEST_F(BackendSelectionTest, MainGpuQualifiedSelectsNthOfFamily) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, CUDA1_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  EXPECT_EQ(
      chooseWithMainGpu(mockBackend, MainGpuQualified{"cuda", 1}).name, "cuda1");
}

// The point of the qualified form: the same card whatever order the backends
// registered in.
TEST_F(BackendSelectionTest, MainGpuQualifiedIsIndependentOfEnumerationOrder) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  EXPECT_EQ(
      chooseWithMainGpu(mockBackend, MainGpuQualified{"cuda", 0}).name, "cuda0");
}

TEST_F(BackendSelectionTest, MainGpuQualifiedOutOfRangeFallsThrough) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  EXPECT_EQ(
      chooseWithMainGpu(mockBackend, MainGpuQualified{"cuda", 4}).name, "cuda0");
}

TEST_F(BackendSelectionTest, MainGpuBusIdSelectsMatchingDevice) {
  mockBackend.addDevice(
      withDeviceId(createGPUDevice(TESLA_DESC, CUDA0_BACK), "0000:65:00.0"));
  mockBackend.addDevice(
      withDeviceId(createGPUDevice(NVIDIA_DESC, CUDA1_BACK), "0000:b3:00.0"));
  EXPECT_EQ(
      chooseWithMainGpu(mockBackend, MainGpuBusId{"0000:b3:00.0"}).name,
      "cuda1");
}

TEST_F(BackendSelectionTest, MainGpuBusIdNotFoundFallsThrough) {
  mockBackend.addDevice(
      withDeviceId(createGPUDevice(TESLA_DESC, CUDA0_BACK), "0000:65:00.0"));
  EXPECT_EQ(
      chooseWithMainGpu(mockBackend, MainGpuBusId{"0000:ff:00.0"}).name,
      "cuda0");
}

// A backend that publishes no bus id cannot be addressed this way; falling
// through beats failing a load over a device the caller may not have meant.
TEST_F(BackendSelectionTest, MainGpuBusIdWithoutPublishedIdsFallsThrough) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  EXPECT_EQ(
      chooseWithMainGpu(mockBackend, MainGpuBusId{"0000:65:00.0"}).name,
      "cuda0");
}

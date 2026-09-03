#include <algorithm>
#include <cctype>
#include <iostream>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "test_common.hpp"
#include "utils/BackendSelection.hpp"

using namespace backend_selection;
using test_common::MockModelMetaData;

// Mock types for ggml backend structures
struct MockDevice {
  std::string description;
  std::string backend_name;
  std::string regName;
  enum ggml_backend_dev_type type;
  /// Whether this device's backend registry exposes
  /// `ggml_backend_split_buffer_type`, i.e. whether it can do row-split. Only
  /// SYCL does as of qvac-fabric v10069, so this defaults to false.
  bool hasSplitBuffers = false;
  /// `ggml_backend_dev_props::device_id` — the PCI bus id, published by both
  /// CUDA and Vulkan and unique per physical card. Empty means ggml reported
  /// null, which is the "cannot dedupe, keep it" case. Descriptions are NOT
  /// unique: Vulkan reports the raw device name, identical across identical
  /// cards.
  std::string deviceId;
  /// KV-cache type names this device's backend cannot run, as
  /// `deviceSupportsKvCacheType` would answer. Empty means it runs everything.
  std::vector<std::string> unsupportedKvTypes;

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

static MockDevice withSplitBuffers(MockDevice device) {
  device.hasSplitBuffers = true;
  return device;
}

/// The TurboQuant/PolarQuant types CUDA has no kernels for, as of the pinned
/// qvac-fabric. Used to stand a device up as incapable of running them.
static MockDevice withoutTurboQuant(MockDevice device) {
  device.unsupportedKvTypes = {"tbq3_0", "tbq4_0", "pq3_0", "pq4_0"};
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

// Mock BackendInterface implementation
class MockBackendInterface {
public:
  std::vector<MockDevice> devices;
  // Store string results to ensure they persist during function calls
  mutable std::vector<std::string> string_storage;

  // Static pointer for function pointer callbacks (thread-safe for tests)
  static thread_local MockBackendInterface* currentInstance;

  void addDevice(const MockDevice& device) { devices.push_back(device); }

  void clearDevices() {
    devices.clear();
    string_storage.clear();
  }

  // Convert to BackendInterface function pointers
  BackendInterface toBackendInterface() const {
    // Set current instance for static callbacks
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
        &MockBackendInterface::static_llamaLogCallback,
        &MockBackendInterface::static_supports_kv_cache_type};
  }

  /// A BackendInterface with the capability probe left null, which is how a
  /// caller that predates it looks. The filter must then fail open.
  BackendInterface toBackendInterfaceWithoutKvProbe() const {
    BackendInterface bckI = toBackendInterface();
    bckI.deviceSupportsKvCacheType = nullptr;
    return bckI;
  }

private:
  void setCurrentInstance() { currentInstance = this; }

  // Static callback functions
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

  // Stands in for the SET_ROWS supports_op probe. A device lists the KV-cache
  // type names its backend cannot run; everything else it can.
  static bool
  static_supports_kv_cache_type(ggml_backend_dev_t dev, enum ggml_type kvType) {
    if (currentInstance == nullptr || dev == nullptr) {
      return true;
    }
    MockDevice* mock_dev = reinterpret_cast<MockDevice*>(dev);
    const char* name = ggml_type_name(kvType);
    if (name == nullptr) {
      return true;
    }
    return std::ranges::find(mock_dev->unsupportedKvTypes, std::string(name)) ==
           mock_dev->unsupportedKvTypes.end();
  }

  static void static_llamaLogCallback(
      ggml_log_level level, const char* text, void* userData) {
    std::cout << "LLAMA LOG CALLBACK: " << text << std::endl;
  }
};

// Thread-local storage for the current instance
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

// GPU Description
constexpr const char* ADRENO_DESC = "Adreno (TM) 740";
constexpr const char* ADRENO_830_DESC = "Adreno (TM) 830";
constexpr const char* ADRENO_650_DESC = "Adreno (TM) 650";
constexpr const char* MALI_DESC = "Mali-G715";

// GPU Backend
constexpr const char* VULKAN0_BACK = "Vulkan0";
constexpr const char* VULKAN1_BACK = "Vulkan1";
constexpr const char* OPENCL_BACK = "GPUOpenCL";

void expectChosen(
    std::pair<BackendType, std::string>& result, BackendType expectedBackend,
    const std::string& expectedBackendName) {
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
  auto result = chooseBackend(expectedBackend, bckI, nullptr, mainGpu);
  expectChosen(result, expectedBackend, expectedBackendName);
}

void expectChosenWithMetadata(
    MockBackendInterface& mockBackend, BackendType preferredBackend,
    BackendType expectedBackend, const std::string& expectedBackendName,
    const ModelMetaData& metadata,
    const std::optional<MainGpu>& mainGpu = std::nullopt) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(preferredBackend, bckI, &metadata, mainGpu);
  expectChosen(result, expectedBackend, expectedBackendName);
}

void expectChosenFinetuning(
    MockBackendInterface& mockBackend, BackendType preferredBackend,
    BackendType expectedBackend, const std::string& expectedBackendName,
    const ModelMetaData& metadata) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(
      preferredBackend, bckI, &metadata, std::nullopt, nullptr, true);
  expectChosen(result, expectedBackend, expectedBackendName);
}

void expectFinetuningThrows(
    MockBackendInterface& mockBackend, BackendType preferredBackend,
    const ModelMetaData* metadata = nullptr) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_THROW(
      chooseBackend(
          preferredBackend, bckI, metadata, std::nullopt, nullptr, true),
      qvac_errors::StatusError);
}

// Adreno OpenCL and Vulkan backend -> chooses OpenCL
TEST_F(BackendSelectionTest, AdrenoOpenCLAndVulkanChoosesOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl");
}

// Some how OpenCL gets tagged as GPU instead of IGPU
// [Llama.cpp] Backend detected: description = adreno (tm) 830, backend =
// vulkan0, type = IGPU [Llama.cpp] Backend detected: description = qualcomm
// adreno(tm) 830, backend = gpuopencl, type = GPU
TEST_F(BackendSelectionTest, AdrenoOpenCLAndIVulkanChoosesOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl");
}

// Make sure that for Adreno still works with OpenCL even when chosing any
// MainGgpu::*
TEST_F(
    BackendSelectionTest,
    AdrenoOpenCLAndIVulkanChoosesOpenCLMainGpuIntegrated) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl", mainGpu);
}

// Make sure that for Adreno still works with OpenCL even when chosing any
// MainGgpu::*
TEST_F(
    BackendSelectionTest, AdrenoOpenCLAndIVulkanChoosesOpenCLMainGpuDedicated) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MainGpu mainGpu = MainGpuType::Dedicated;
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl", mainGpu);
}

// Vulkan backend and OpenCL but not Adreno -> chooses Vulkan
TEST_F(BackendSelectionTest, VulkanAndOpenCLNotAdrenoChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

// Only Vulkan MALI chooses Vulkan
TEST_F(BackendSelectionTest, OnlyVulkanMaliChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

// Vulkan backend on integrated GPU
TEST_F(BackendSelectionTest, VulkanIGPU) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

// Vulkan GPU backend prefered over integrated GPU
TEST_F(BackendSelectionTest, VulkanGPUOverIGPUWhenGPUBack) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan1");
}

// Vulkan GPU backend prefered over integrated GPU
TEST_F(BackendSelectionTest, VulkanGPUOverIGPUWhenIGPUBack) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN1_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

// No GPU backends but preferred GPU, fallback to CPU
TEST_F(BackendSelectionTest, NoGPUBackendsPreferredGPUGoesToCPU) {
  expectChosen(mockBackend, BackendType::CPU, "none");
}

// Preferred CPU always returns CPU
TEST_F(BackendSelectionTest, PreferredCPUAlwaysReturnsCPU) {
  // Setup: Even with GPU devices available
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::CPU, "none");
}

// RPC backend is ignored
TEST_F(BackendSelectionTest, RPCBackendIsIgnored) {
  mockBackend.addDevice(
      MockDevice("Adreno 840", "OpenCL", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

// Multiple Adreno OpenCL/Vulkan backends - chooses opencl
TEST_F(BackendSelectionTest, MultipleAdrenoOpenCLChoosesFirst) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "gpuopencl");
}

// Metal GPU should be chosen over CPU when available
TEST_F(BackendSelectionTest, MetalGPUShouldBeChosenOverCPU) {
  mockBackend.addDevice(createGPUDevice("apple m1", "metal"));
  mockBackend.addDevice(createACCELDevice("accelerate", "blas"));
  mockBackend.addDevice(createCPUDevice("apple m1", "cpu"));
  expectChosen(mockBackend, BackendType::GPU, "metal");
}

// Test tryMainGpuFromMap with integer device index
TEST_F(BackendSelectionTest, TryMainGpuFromMapWithInteger) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "0";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<int>(result.value()));
  EXPECT_EQ(std::get<int>(result.value()), 0);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

// Test tryMainGpuFromMap with different integer device index
TEST_F(BackendSelectionTest, TryMainGpuFromMapWithIntegerOne) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "1";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<int>(result.value()));
  EXPECT_EQ(std::get<int>(result.value()), 1);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

// Test tryMainGpuFromMap with "integrated" enum value
TEST_F(BackendSelectionTest, TryMainGpuFromMapWithIntegrated) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "integrated";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Integrated);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

// Test tryMainGpuFromMap with "dedicated" enum value
TEST_F(BackendSelectionTest, TryMainGpuFromMapWithDedicated) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "dedicated";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Dedicated);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

// Test tryMainGpuFromMap with case-insensitive "integrated"
TEST_F(BackendSelectionTest, TryMainGpuFromMapWithIntegratedCaseInsensitive) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "INTEGRATED";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Integrated);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

// Test tryMainGpuFromMap with case-insensitive "dedicated"
TEST_F(BackendSelectionTest, TryMainGpuFromMapWithDedicatedCaseInsensitive) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["main-gpu"] = "DEDICATED";

  auto result = tryMainGpuFromMap(configFilemap);

  ASSERT_TRUE(result.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuType>(result.value()));
  EXPECT_EQ(std::get<MainGpuType>(result.value()), MainGpuType::Dedicated);
  EXPECT_EQ(configFilemap.find("main-gpu"), configFilemap.end());
}

// Test tryMainGpuFromMap when key is not present
TEST_F(BackendSelectionTest, TryMainGpuFromMapWhenKeyNotPresent) {
  std::unordered_map<std::string, std::string> configFilemap;
  configFilemap["other-key"] = "value";

  auto result = tryMainGpuFromMap(configFilemap);

  EXPECT_FALSE(result.has_value());
  EXPECT_EQ(configFilemap.size(), 1);
  EXPECT_NE(configFilemap.find("other-key"), configFilemap.end());
}

// Test tryMainGpuFromMap with empty map
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

// Integration test: chooseBackend with main-gpu integer index
TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegerIndex) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));

  MainGpu mainGpu = 0;
  expectChosen(mockBackend, BackendType::GPU, "vulkan0", mainGpu);
}

// Integration test: chooseBackend with main-gpu integrated enum
TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegrated) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));

  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosen(mockBackend, BackendType::GPU, "vulkan0", mainGpu);
}

// Integration test: chooseBackend with main-gpu dedicated enum
TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuDedicated) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));

  MainGpu mainGpu = MainGpuType::Dedicated;
  expectChosen(mockBackend, BackendType::GPU, "vulkan1", mainGpu);
}

// Integration test: chooseBackend with main-gpu integer index selecting second
// device
TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegerIndexOne) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));

  MainGpu mainGpu = 1;
  expectChosen(mockBackend, BackendType::GPU, "vulkan1", mainGpu);
}

// ---- BitNet TQ backend selection for Adreno GPUs ----

// Adreno 830 (800+) with bitnet TQ: should prefer Vulkan over OpenCL
TEST_F(BackendSelectionTest, BitnetTQ_Adreno830_ChoosesVulkanOverOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", bitnetMeta);
}

// Adreno 740 (<800) with bitnet TQ: should fall back to CPU
TEST_F(BackendSelectionTest, BitnetTQ_Adreno740_ChoosesCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", bitnetMeta);
}

// Adreno 830 without bitnet: should still choose OpenCL (existing behavior)
TEST_F(BackendSelectionTest, NoBitnet_Adreno830_ChoosesOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData nonBitnetMeta(false, "llama");
  expectChosenWithMetadata(
      mockBackend,
      BackendType::GPU,
      BackendType::GPU,
      "gpuopencl",
      nonBitnetMeta);
}

// Adreno 740 without bitnet: should still choose OpenCL (existing behavior)
TEST_F(BackendSelectionTest, NoBitnet_Adreno740_ChoosesOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData nonBitnetMeta(false, "llama");
  expectChosenWithMetadata(
      mockBackend,
      BackendType::GPU,
      BackendType::GPU,
      "gpuopencl",
      nonBitnetMeta);
}

// Non-Adreno GPU with bitnet: normal GPU selection (no special behavior)
TEST_F(BackendSelectionTest, BitnetTQ_Mali_ChoosesVulkanNormally) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", bitnetMeta);
}

// Mali Vulkan + Qwen3.5: keeps GPU (the Mali-CPU override is disabled
// for now; see chooseBackend).
TEST_F(BackendSelectionTest, Qwen35_Mali_KeepsVulkan) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  MockModelMetaData qwen35Meta(false, "qwen35");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", qwen35Meta);
}

TEST_F(BackendSelectionTest, Qwen35Moe_Mali_KeepsVulkan) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  MockModelMetaData qwen35MoeMeta(false, "qwen35moe");
  expectChosenWithMetadata(
      mockBackend,
      BackendType::GPU,
      BackendType::GPU,
      "vulkan0",
      qwen35MoeMeta);
}

// Qwen3 (3.0) on Mali: keeps GPU (unchanged).
TEST_F(BackendSelectionTest, Qwen3_Mali_KeepsVulkan) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  MockModelMetaData qwen3Meta(false, "qwen3");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", qwen3Meta);
}

// Qwen3.5 on Adreno: keeps GPU (unchanged).
TEST_F(BackendSelectionTest, Qwen35_Adreno_KeepsGPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  MockModelMetaData qwen35Meta(false, "qwen35");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::GPU, "gpuopencl", qwen35Meta);
}

// Adreno 800+ with bitnet TQ, only OpenCL available (no Vulkan): falls to CPU
TEST_F(BackendSelectionTest, BitnetTQ_Adreno830_OnlyOpenCL_FallsToCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", bitnetMeta);
}

// Adreno 800+ with bitnet TQ, both Vulkan GPU and iGPU: prefers GPU Vulkan
TEST_F(BackendSelectionTest, BitnetTQ_Adreno830_VulkanGPUAndIGPU_ChoosesGPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN1_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", bitnetMeta);
}

// Adreno 740 (<800) with bitnet TQ, only Vulkan (no OpenCL device): should
// fall back to CPU. maxAdrenoVersion must be populated from Vulkan device.
TEST_F(BackendSelectionTest, BitnetTQ_Adreno740_OnlyVulkan_ChoosesCPU) {
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", bitnetMeta);
}

// Adreno 830 (800+) with bitnet TQ, only Vulkan (no OpenCL device): should
// choose Vulkan. maxAdrenoVersion must be populated from Vulkan device.
TEST_F(BackendSelectionTest, BitnetTQ_Adreno830_OnlyVulkan_ChoosesVulkan) {
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", bitnetMeta);
}

// ---- Explicit mainGpu bypasses bitnet Adreno logic ----

// Adreno 830 + bitnet + explicit mainGpu index: should keep OpenCL (normal
// Adreno path), NOT switch to Vulkan (bitnet special path).
TEST_F(
    BackendSelectionTest, BitnetTQ_Adreno830_ExplicitMainGpuIndex_KeepsOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  MainGpu mainGpu = 0;
  expectChosenWithMetadata(
      mockBackend,
      BackendType::GPU,
      BackendType::GPU,
      "gpuopencl",
      bitnetMeta,
      mainGpu);
}

// Adreno 740 (<800) + bitnet + explicit mainGpu index: should keep OpenCL,
// NOT fall back to CPU (bitnet special path).
TEST_F(
    BackendSelectionTest, BitnetTQ_Adreno740_ExplicitMainGpuIndex_KeepsOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  MainGpu mainGpu = 0;
  expectChosenWithMetadata(
      mockBackend,
      BackendType::GPU,
      BackendType::GPU,
      "gpuopencl",
      bitnetMeta,
      mainGpu);
}

// Adreno 830 + bitnet + explicit mainGpu Integrated: should keep OpenCL,
// NOT switch to Vulkan.
TEST_F(
    BackendSelectionTest,
    BitnetTQ_Adreno830_ExplicitMainGpuIntegrated_KeepsOpenCL) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosenWithMetadata(
      mockBackend,
      BackendType::GPU,
      BackendType::GPU,
      "gpuopencl",
      bitnetMeta,
      mainGpu);
}

// ---- Finetuning backend selection for Adreno GPUs ----

// -- Adreno 829 (800+) with known arch: always Vulkan --

TEST_F(BackendSelectionTest, Finetuning_Gemma3_Adreno830_ChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "gemma3");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", meta);
}

TEST_F(BackendSelectionTest, Finetuning_Qwen3_Adreno830_ChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "qwen3");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", meta);
}

TEST_F(BackendSelectionTest, Finetuning_Bitnet_Adreno830_ChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(true, "bitnet");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", meta);
}

// Archs this PR added to SUPPORTED_FINETUNE_ARCHITECTURES
// (BackendSelection.cpp). These lock the finetune allowlist so a future edit
// that drops one is caught by a fast unit test rather than only by a slow,
// opt-in on-device finetune.
TEST_F(BackendSelectionTest, Finetuning_Qwen35_Adreno830_ChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "qwen35");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", meta);
}

TEST_F(BackendSelectionTest, Finetuning_Qwen35Moe_Adreno830_ChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "qwen35moe");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", meta);
}

TEST_F(BackendSelectionTest, Finetuning_Gemma4_Adreno830_ChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "gemma4");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", meta);
}

// -- Adreno 740 (<800) with known arch: always CPU --

TEST_F(BackendSelectionTest, Finetuning_Gemma3_Adreno740_ChoosesCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "gemma3");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", meta);
}

TEST_F(BackendSelectionTest, Finetuning_Qwen3_Adreno740_ChoosesCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "qwen3");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", meta);
}

TEST_F(BackendSelectionTest, Finetuning_Bitnet_Adreno740_ChoosesCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData meta(true, "bitnet");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", meta);
}

// -- Adreno 650 (600+) with known arch: always CPU --

TEST_F(BackendSelectionTest, Finetuning_Gemma3_Adreno650_ChoosesCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_650_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_650_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "gemma3");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", meta);
}

TEST_F(BackendSelectionTest, Finetuning_Qwen3_Adreno650_ChoosesCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_650_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_650_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "qwen3");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", meta);
}

TEST_F(BackendSelectionTest, Finetuning_Bitnet_Adreno650_ChoosesCPU) {
  mockBackend.addDevice(createGPUDevice(ADRENO_650_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_650_DESC, VULKAN0_BACK));
  MockModelMetaData meta(true, "bitnet");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", meta);
}

// -- Finetuning with no metadata: throws (unsupported architecture) --

TEST_F(BackendSelectionTest, Finetuning_NoMetadata_Adreno830_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  expectFinetuningThrows(mockBackend, BackendType::GPU);
}

TEST_F(BackendSelectionTest, Finetuning_NoMetadata_Adreno740_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectFinetuningThrows(mockBackend, BackendType::GPU);
}

TEST_F(BackendSelectionTest, Finetuning_NoMetadata_Adreno650_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_650_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_650_DESC, VULKAN0_BACK));
  expectFinetuningThrows(mockBackend, BackendType::GPU);
}

// -- Finetuning with unknown architecture in metadata: throws --

TEST_F(BackendSelectionTest, Finetuning_UnknownArch_Adreno830_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "unknown_arch");
  expectFinetuningThrows(mockBackend, BackendType::GPU, &meta);
}

TEST_F(BackendSelectionTest, Finetuning_UnknownArch_Adreno740_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "unknown_arch");
  expectFinetuningThrows(mockBackend, BackendType::GPU, &meta);
}

TEST_F(BackendSelectionTest, Finetuning_UnknownArch_Adreno650_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_650_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_650_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "unknown_arch");
  expectFinetuningThrows(mockBackend, BackendType::GPU, &meta);
}

// -- Finetuning on Mali: keeps GPU (the Mali finetune-CPU override is
// disabled for now; only the Qwen3.5 inference override is active) --

TEST_F(BackendSelectionTest, Finetuning_Gemma3_Mali_KeepsVulkan) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "gemma3");
  expectChosenFinetuning(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", meta);
}

// Inference (non-finetuning) on Mali with a non-Qwen3.5 arch keeps the GPU.
TEST_F(BackendSelectionTest, Inference_Gemma3_Mali_KeepsVulkan) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "gemma3");
  expectChosenWithMetadata(
      mockBackend, BackendType::GPU, BackendType::GPU, "vulkan0", meta);
}

// -- Finetuning on non-Adreno GPU with unsupported arch: throws --

TEST_F(BackendSelectionTest, Finetuning_Llama_Mali_Throws) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "llama");
  expectFinetuningThrows(mockBackend, BackendType::GPU, &meta);
}

// -- llama is NOT in known finetuning architectures → throws --

TEST_F(BackendSelectionTest, Finetuning_Llama_Adreno830_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "llama");
  expectFinetuningThrows(mockBackend, BackendType::GPU, &meta);
}

TEST_F(BackendSelectionTest, Finetuning_Llama_Adreno740_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "llama");
  expectFinetuningThrows(mockBackend, BackendType::GPU, &meta);
}

TEST_F(BackendSelectionTest, Finetuning_Llama_Adreno650_Throws) {
  mockBackend.addDevice(createGPUDevice(ADRENO_650_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_650_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "llama");
  expectFinetuningThrows(mockBackend, BackendType::GPU, &meta);
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

// QVAC-21867: chooseBackend reports Mali GPUs via outIsMaliGpu so the caller
// can pick the per-device-class default for the multimodal projector backend.
TEST_F(BackendSelectionTest, OutIsMaliGpuTrueForMaliVulkan) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  bool isMaliGpu = false;
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      nullptr,
      std::nullopt,
      nullptr,
      false,
      &isMaliGpu);
  EXPECT_EQ(result.first, BackendType::GPU);
  EXPECT_TRUE(isMaliGpu);
}

TEST_F(BackendSelectionTest, OutIsMaliGpuTrueForMaliIGpuCaseInsensitive) {
  mockBackend.addDevice(createIGPUDevice("ARM MALI-G710", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  bool isMaliGpu = false;
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      nullptr,
      std::nullopt,
      nullptr,
      false,
      &isMaliGpu);
  EXPECT_EQ(result.first, BackendType::GPU);
  EXPECT_TRUE(isMaliGpu);
}

TEST_F(BackendSelectionTest, OutIsMaliGpuFalseForAdreno) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  bool isMaliGpu = true;
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      nullptr,
      std::nullopt,
      nullptr,
      false,
      &isMaliGpu);
  EXPECT_EQ(result.first, BackendType::GPU);
  EXPECT_FALSE(isMaliGpu);
}

TEST_F(BackendSelectionTest, OutIsMaliGpuFalseForDesktopGpu) {
  mockBackend.addDevice(createGPUDevice("nvidia rtx 4090", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  bool isMaliGpu = true;
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      nullptr,
      std::nullopt,
      nullptr,
      false,
      &isMaliGpu);
  EXPECT_EQ(result.first, BackendType::GPU);
  EXPECT_FALSE(isMaliGpu);
}

TEST_F(BackendSelectionTest, OutIsMaliGpuFalseWhenNoGpuDevices) {
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  bool isMaliGpu = true;
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      nullptr,
      std::nullopt,
      nullptr,
      false,
      &isMaliGpu);
  EXPECT_EQ(result.first, BackendType::CPU);
  EXPECT_FALSE(isMaliGpu);
}

TEST_F(BackendSelectionTest, OutIsMaliGpuFalseWhenPreferredCpu) {
  // Devices are only enumerated for GPU preference; CPU preference must
  // report no Mali rather than stale/true.
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  bool isMaliGpu = true;
  auto result = chooseBackend(
      BackendType::CPU,
      bckI,
      nullptr,
      std::nullopt,
      nullptr,
      false,
      &isMaliGpu);
  EXPECT_EQ(result.first, BackendType::CPU);
  EXPECT_FALSE(isMaliGpu);
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
  return chooseBackend(
      preferred,
      bckI,
      nullptr,
      std::nullopt,
      nullptr,
      false,
      nullptr,
      backendOverride);
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

TEST_F(BackendSelectionTest, CudaAloneIsChosen) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, CUDA0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "cuda0");
}

// A discrete CUDA GPU must still beat an integrated GPU.
TEST_F(BackendSelectionTest, CudaPreferredOverIntegratedGpu) {
  mockBackend.addDevice(createIGPUDevice("Intel Arc", VULKAN0_BACK));
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
  // Both land in the generic GPU bucket, so the first registered one wins and
  // the CUDA branch is never taken.
  expectChosen(mockBackend, BackendType::GPU, "rocm0");
}

// device 'cpu' must not enumerate a CUDA device.
TEST_F(BackendSelectionTest, CudaIgnoredWhenPreferredCpu) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, CUDA0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(BackendType::CPU, bckI);
  EXPECT_EQ(result.first, BackendType::CPU);
}

TEST_F(BackendSelectionTest, OverrideForcesVulkanOnACudaHost) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  auto result = chooseWithOverride(mockBackend, {"vulkan"});
  expectChosen(result, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, OverrideHonoursPriorityOrder) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  auto vulkanFirst = chooseWithOverride(mockBackend, {"vulkan", "cuda"});
  expectChosen(vulkanFirst, BackendType::GPU, "vulkan0");
  auto cudaFirst = chooseWithOverride(mockBackend, {"cuda", "vulkan"});
  expectChosen(cudaFirst, BackendType::GPU, "cuda0");
}

// First entry absent, second present: skip to the second rather than failing.
TEST_F(BackendSelectionTest, OverrideSkipsAbsentBackend) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, VULKAN0_BACK));
  auto result = chooseWithOverride(mockBackend, {"cuda", "vulkan"});
  expectChosen(result, BackendType::GPU, "vulkan0");
}

// Correctly spelled but nothing matches: fall through to the normal cascade
// instead of failing the load, because an absent device is not a config error.
TEST_F(BackendSelectionTest, OverrideFallsBackWhenNothingMatches) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, VULKAN0_BACK));
  auto result = chooseWithOverride(mockBackend, {"cuda"});
  expectChosen(result, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, OverrideFallsBackToCpuWhenNoGpuAtAll) {
  auto result = chooseWithOverride(mockBackend, {"cuda", "vulkan"});
  EXPECT_EQ(result.first, BackendType::CPU);
}

// The override selects a family, not a device index: with two CUDA devices the
// first one still wins.
TEST_F(BackendSelectionTest, OverridePicksFirstDeviceOfFamily) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA1_BACK));
  auto result = chooseWithOverride(mockBackend, {"cuda"});
  expectChosen(result, BackendType::GPU, "cuda0");
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

// An override must not resurrect a device a guard just cleared. BitNet TQ on
// Adreno 800+ prefers Vulkan by clearing the OpenCL bucket.
TEST_F(
    BackendSelectionTest, OverrideCannotResurrectOpenClClearedByBitNetGuard) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      &bitnetMeta,
      std::nullopt,
      nullptr,
      false,
      nullptr,
      {"opencl"});
  expectChosen(result, BackendType::GPU, "vulkan0");
}

// Finetuning on Adreno <800 is CPU only, so no override may reach a GPU.
TEST_F(BackendSelectionTest, OverrideCannotResurrectGpuClearedByFinetuneGuard) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "qwen3");
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      &meta,
      std::nullopt,
      nullptr,
      true,
      nullptr,
      {"vulkan", "opencl"});
  EXPECT_EQ(result.first, BackendType::CPU);
}

// The two guards above have a second arm each, and neither was pinned. Both
// matter for QVAC-23763: the override block sits after the guards today, so the
// invariant holds by block ordering alone. Anything that reorders them, or that
// replaces bucket mutation with per-candidate filtering, has to keep all four
// arms working.

// BitNet TQ on Adreno <800 is CPU only (TQ kernels run faster there), so no
// override may reach a GPU. The 800+ arm of this guard is pinned above.
TEST_F(
    BackendSelectionTest, OverrideCannotResurrectGpuClearedByBitNetGuardSub800) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      &bitnetMeta,
      std::nullopt,
      nullptr,
      false,
      nullptr,
      {"vulkan", "opencl"});
  EXPECT_EQ(result.first, BackendType::CPU);
}

// Finetuning on Adreno 800+ prefers Vulkan by clearing OpenCL, so an explicit
// opencl override must land on Vulkan rather than resurrecting it. The <800 arm
// of this guard is pinned above.
TEST_F(
    BackendSelectionTest,
    OverrideCannotResurrectOpenClClearedByFinetuneGuard800Plus) {
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(ADRENO_830_DESC, VULKAN0_BACK));
  MockModelMetaData meta(false, "qwen3");
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      &meta,
      std::nullopt,
      nullptr,
      true,
      nullptr,
      {"opencl"});
  expectChosen(result, BackendType::GPU, "vulkan0");
}

// clearAllGpuBackends() grew a cudaBackends.clear() for QVAC-23763. Nothing
// pinned it, so a CUDA device could be resurrected out of a cleared bucket by an
// override. Contrived host - CUDA beside an Adreno - but the mechanism is the
// point, and it is the arm a per-candidate filter is most likely to miss.
TEST_F(BackendSelectionTest, OverrideCannotResurrectCudaClearedByFinetuneGuard) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  MockModelMetaData meta(false, "qwen3");
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(
      BackendType::GPU,
      bckI,
      &meta,
      std::nullopt,
      nullptr,
      true,
      nullptr,
      {"cuda"});
  EXPECT_EQ(result.first, BackendType::CPU);
}

// ---- the capability filter (QVAC-23763 R9/R10) ----

static BackendChoice chooseWithKvTypes(
    MockBackendInterface& mockBackend,
    const std::vector<const char*>& kvTypeNames,
    BackendType preferred = BackendType::GPU,
    const std::vector<std::string>& backendOverride = {}) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  BackendRequest request;
  request.preferred = preferred;
  request.backendOverride = backendOverride;
  for (const char* n : kvTypeNames) {
    request.constraints.kvCacheTypes.push_back(kvCacheTypeFromString(n));
  }
  return chooseBackend(request, bckI);
}

// The headline: a TurboQuant load on an NVIDIA host that also has Vulkan used
// to be refused after CUDA was already chosen. It now steps down instead.
TEST_F(BackendSelectionTest, CudaDemotedToVulkanForTurboQuant) {
  mockBackend.addDevice(withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  const BackendChoice choice = chooseWithKvTypes(mockBackend, {"tbq4_0"});
  EXPECT_EQ(choice.type, BackendType::GPU);
  EXPECT_EQ(choice.name, "vulkan0");
  EXPECT_EQ(choice.trace.skippedName, "cuda0");
  EXPECT_EQ(choice.trace.skippedReason, ExclusionReason::KvCacheTypeUnsupported);
}

TEST_F(BackendSelectionTest, CudaDemotedForPolarQuantToo) {
  mockBackend.addDevice(withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  EXPECT_EQ(chooseWithKvTypes(mockBackend, {"pq3_0"}).name, "vulkan0");
}

// A quantized type CUDA *can* run must not trigger the filter, or every
// quantized-KV load on an NVIDIA host silently moves to Vulkan.
TEST_F(BackendSelectionTest, CudaKeptForStandardQuantizedKvType) {
  mockBackend.addDevice(withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  EXPECT_EQ(chooseWithKvTypes(mockBackend, {"q8_0"}).name, "cuda0");
  EXPECT_EQ(chooseWithKvTypes(mockBackend, {"f16"}).name, "cuda0");
}

// Either side of the cache being unsupported is enough to pass the device over.
TEST_F(BackendSelectionTest, KvConstraintChecksEveryRequestedType) {
  mockBackend.addDevice(withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  EXPECT_EQ(chooseWithKvTypes(mockBackend, {"q8_0", "tbq4_0"}).name, "vulkan0");
  EXPECT_EQ(chooseWithKvTypes(mockBackend, {"tbq4_0", "q8_0"}).name, "vulkan0");
}

// No GPU can run it and the caller asked for a GPU: failing is better than
// quietly running an order of magnitude slower on CPU.
TEST_F(BackendSelectionTest, CudaOnlyHostWithTurboQuantThrows) {
  mockBackend.addDevice(withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  try {
    chooseWithKvTypes(mockBackend, {"tbq4_0"});
    FAIL() << "expected a StatusError";
  } catch (const qvac_errors::StatusError& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("cuda0"), std::string::npos) << what;
    EXPECT_NE(what.find("tbq4_0"), std::string::npos) << what;
  }
}

// ...but a deliberate CPU load must not throw. No devices are enumerated, so
// there is nothing to be incapable.
TEST_F(BackendSelectionTest, CpuLoadWithTurboQuantDoesNotThrow) {
  mockBackend.addDevice(withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  const BackendChoice choice =
      chooseWithKvTypes(mockBackend, {"tbq4_0"}, BackendType::CPU);
  EXPECT_EQ(choice.type, BackendType::CPU);
}

// The guards that merely prefer another backend must still reach CPU silently.
// Conflating them with "incapable" would turn BitNet-on-Adreno<800 from a
// working CPU run into a failed load on every shipped Adreno 740.
TEST_F(BackendSelectionTest, PreferOtherGuardsStillFallToCpuWithoutThrowing) {
  mockBackend.addDevice(createGPUDevice(ADRENO_DESC, OPENCL_BACK));
  MockModelMetaData bitnetMeta(true, "bitnet");
  BackendInterface bckI = mockBackend.toBackendInterface();
  BackendRequest request;
  request.preferred = BackendType::GPU;
  request.metadata = &bitnetMeta;
  EXPECT_EQ(chooseBackend(request, bckI).type, BackendType::CPU);
}

// A null probe is how any BackendInterface built before this existed looks. It
// must fail OPEN, or a forgotten initialiser silently disables the filter in
// the other direction and refuses a device that works.
TEST_F(BackendSelectionTest, NullKvCapabilityProbeFailsOpen) {
  mockBackend.addDevice(withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  bckI.deviceSupportsKvCacheType = nullptr;
  BackendRequest request;
  request.preferred = BackendType::GPU;
  request.constraints.kvCacheTypes.push_back(kvCacheTypeFromString("tbq4_0"));
  EXPECT_EQ(chooseBackend(request, bckI).name, "cuda0");
}

// The resurrect invariant, for the new reason: an override naming a device the
// capability filter ruled out must not bring it back.
TEST_F(BackendSelectionTest, OverrideCannotResurrectKvExcludedCuda) {
  mockBackend.addDevice(withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  const BackendChoice choice =
      chooseWithKvTypes(mockBackend, {"tbq4_0"}, BackendType::GPU, {"cuda"});
  EXPECT_EQ(choice.name, "vulkan0");
}

// ---- backend-required (QVAC-23763 R11) ----

static BackendChoice chooseWithRequired(
    MockBackendInterface& mockBackend,
    const std::vector<std::string>& backendOverride, bool required,
    const std::vector<const char*>& kvTypeNames = {}) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  BackendRequest request;
  request.preferred = BackendType::GPU;
  request.backendOverride = backendOverride;
  request.backendRequired = required;
  for (const char* n : kvTypeNames) {
    request.constraints.kvCacheTypes.push_back(kvCacheTypeFromString(n));
  }
  return chooseBackend(request, bckI);
}

// Without it a pin is advisory. That is the behaviour that made the integration
// suites' backend pins silently meaningless.
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

// A device the capability filter ruled out must not satisfy a strict pin
// either, and the error should say why it was passed over.
TEST_F(BackendSelectionTest, StrictOverrideThrowsWhenMatchWasFiltered) {
  mockBackend.addDevice(
      withoutTurboQuant(createGPUDevice(TESLA_DESC, CUDA0_BACK)));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  try {
    chooseWithRequired(mockBackend, {"cuda"}, true, {"tbq4_0"});
    FAIL() << "expected a StatusError";
  } catch (const qvac_errors::StatusError& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("kv-cache-type-unsupported"), std::string::npos) << what;
  }
}

TEST_F(BackendSelectionTest, StrictOverrideIsSatisfiedByAMatch) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  EXPECT_EQ(chooseWithRequired(mockBackend, {"vulkan"}, true).name, "vulkan0");
}

TEST_F(BackendSelectionTest, BackendRequiredParsing) {
  for (const char* yes : {"true", "on", "1", "TRUE", "On"}) {
    std::unordered_map<std::string, std::string> cfg{{"backend-required", yes}};
    EXPECT_TRUE(tryBackendRequiredFromMap(cfg, true)) << yes;
    EXPECT_EQ(cfg.count("backend-required"), 0u) << yes;
  }
  for (const char* no : {"false", "off", "0"}) {
    std::unordered_map<std::string, std::string> cfg{{"backend-required", no}};
    EXPECT_FALSE(tryBackendRequiredFromMap(cfg, true)) << no;
  }
  // underscore spelling, matching main_gpu / cache_type_k
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

// On its own it would mean "require the default cascade", which is not a thing.
TEST_F(BackendSelectionTest, BackendRequiredWithoutBackendThrows) {
  std::unordered_map<std::string, std::string> cfg{
      {"backend-required", "true"}};
  EXPECT_THROW(tryBackendRequiredFromMap(cfg, false), qvac_errors::StatusError);
  // ...but explicitly false without a backend is harmless
  std::unordered_map<std::string, std::string> off{
      {"backend-required", "false"}};
  EXPECT_FALSE(tryBackendRequiredFromMap(off, false));
}

// ---- main-gpu addressing (QVAC-23763 R13) ----

static BackendChoice chooseWithMainGpu(
    MockBackendInterface& mockBackend, const MainGpu& mainGpu) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  BackendRequest request;
  request.preferred = BackendType::GPU;
  request.mainGpu = mainGpu;
  return chooseBackend(request, bckI);
}

TEST_F(BackendSelectionTest, MainGpuIntegerStillWorks) {
  EXPECT_EQ(parseMainGpu("0"), MainGpu(0));
  EXPECT_EQ(parseMainGpu("3"), MainGpu(3));
  EXPECT_EQ(parseMainGpu("integrated"), MainGpu(MainGpuType::Integrated));
  EXPECT_EQ(parseMainGpu("dedicated"), MainGpu(MainGpuType::Dedicated));
  EXPECT_EQ(parseMainGpu(""), std::nullopt);
}

// std::stoi parsed a leading prefix and threw the rest away. That is what made
// a bus id parse as device 0, so tightening it is a prerequisite for the forms
// below - and a behaviour change worth pinning.
TEST_F(BackendSelectionTest, MainGpuRejectsPartialIntegerParse) {
  EXPECT_THROW(parseMainGpu("1abc"), qvac_errors::StatusError);
  EXPECT_THROW(parseMainGpu("0 1"), qvac_errors::StatusError);
  EXPECT_THROW(parseMainGpu("nonsense"), qvac_errors::StatusError);
}

TEST_F(BackendSelectionTest, MainGpuBusIdNotMisparsedAsZero) {
  const auto parsed = parseMainGpu("0000:65:00.0");
  ASSERT_TRUE(parsed.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuBusId>(parsed.value()));
  EXPECT_EQ(std::get<MainGpuBusId>(parsed.value()).id, "0000:65:00.0");
  // the short form, without the domain
  const auto shortForm = parseMainGpu("65:00.0");
  ASSERT_TRUE(shortForm.has_value());
  EXPECT_TRUE(std::holds_alternative<MainGpuBusId>(shortForm.value()));
}

TEST_F(BackendSelectionTest, MainGpuQualifiedParsing) {
  const auto parsed = parseMainGpu("CUDA:1");
  ASSERT_TRUE(parsed.has_value());
  ASSERT_TRUE(std::holds_alternative<MainGpuQualified>(parsed.value()));
  EXPECT_EQ(std::get<MainGpuQualified>(parsed.value()).family, "cuda");
  EXPECT_EQ(std::get<MainGpuQualified>(parsed.value()).index, 1);
  // hip canonicalises to rocm, as it does for the `backend` key
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
  EXPECT_EQ(
      chooseWithMainGpu(mockBackend, MainGpuQualified{"vulkan", 0}).name,
      "vulkan0");
}

// The point of the qualified form: it names the same card whatever order the
// backends registered in.
TEST_F(BackendSelectionTest, MainGpuQualifiedIsIndependentOfEnumerationOrder) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  EXPECT_EQ(
      chooseWithMainGpu(mockBackend, MainGpuQualified{"cuda", 0}).name, "cuda0");
}

TEST_F(BackendSelectionTest, MainGpuQualifiedOutOfRangeFallsThrough) {
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, CUDA0_BACK));
  mockBackend.addDevice(createGPUDevice(TESLA_DESC, VULKAN0_BACK));
  // device 4 of the cuda family does not exist; selection warns and uses the
  // default order rather than failing, as an out-of-range integer does
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

// ---- kvCacheTypeFromString ----

TEST_F(BackendSelectionTest, KvCacheTypeFromStringResolvesTurboQuant) {
  EXPECT_EQ(kvCacheTypeFromString("tbq3_0"), GGML_TYPE_TBQ3_0);
  EXPECT_EQ(kvCacheTypeFromString("pq3_0"), GGML_TYPE_PQ3_0);
  // The types the addon rejects on CUDA must all be recognised, or the filter
  // silently sees no constraint and the guard never fires.
  for (const char* name : {"tbq3_0", "tbq4_0", "pq3_0", "pq4_0"}) {
    const enum ggml_type t = kvCacheTypeFromString(name);
    EXPECT_NE(t, GGML_TYPE_COUNT) << name;
    EXPECT_TRUE(ggml_is_tbq_or_pq(t)) << name;
  }
}

TEST_F(BackendSelectionTest, KvCacheTypeFromStringResolvesOrdinaryTypes) {
  EXPECT_EQ(kvCacheTypeFromString("f16"), GGML_TYPE_F16);
  EXPECT_EQ(kvCacheTypeFromString("q8_0"), GGML_TYPE_Q8_0);
  // and these must not look like TBQ/PQ, or every quantized load gets filtered
  EXPECT_FALSE(ggml_is_tbq_or_pq(kvCacheTypeFromString("q8_0")));
  EXPECT_FALSE(ggml_is_tbq_or_pq(kvCacheTypeFromString("f16")));
}

TEST_F(BackendSelectionTest, KvCacheTypeFromStringIsCaseInsensitive) {
  EXPECT_EQ(kvCacheTypeFromString("TBQ4_0"), kvCacheTypeFromString("tbq4_0"));
  EXPECT_NE(kvCacheTypeFromString("TBQ4_0"), GGML_TYPE_COUNT);
}

TEST_F(BackendSelectionTest, KvCacheTypeFromStringRejectsNonsense) {
  EXPECT_EQ(kvCacheTypeFromString(""), GGML_TYPE_COUNT);
  EXPECT_EQ(kvCacheTypeFromString("not_a_type"), GGML_TYPE_COUNT);
  // a prefix of a real name must not resolve
  EXPECT_EQ(kvCacheTypeFromString("tbq"), GGML_TYPE_COUNT);
}

// ---- parseBackendOverride ----

TEST_F(BackendSelectionTest, ParseBackendOverrideBasic) {
  EXPECT_EQ(
      parseBackendOverride("CUDA,Vulkan"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST_F(BackendSelectionTest, ParseBackendOverrideTrimsAndLowercases) {
  EXPECT_EQ(
      parseBackendOverride("  CuDa ,  VULKAN  "),
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

TEST_F(BackendSelectionTest, ParseBackendOverrideEmptyStringIsEmptyList) {
  EXPECT_TRUE(parseBackendOverride("").empty());
}

// A misspelled name is a config mistake and must be loud, not silently ignored.
TEST_F(BackendSelectionTest, ParseBackendOverrideRejectsUnknownName) {
  EXPECT_THROW(parseBackendOverride("cudaa"), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride("vulcan"), qvac_errors::StatusError);
  EXPECT_THROW(
      parseBackendOverride("cuda,notabackend"), qvac_errors::StatusError);
}

// 'cpu' is spelled via `device`, not `backend`; accepting both would make
// device:'gpu' + backend:'cpu' ambiguous.
TEST_F(BackendSelectionTest, ParseBackendOverrideRejectsCpu) {
  EXPECT_THROW(parseBackendOverride("cpu"), qvac_errors::StatusError);
}

// ggml's HIP build reports its devices as "ROCm%d", so 'hip' has to arrive at
// the matcher as "rocm" or it pins nothing.
TEST_F(BackendSelectionTest, ParseBackendOverrideCanonicalisesHipToRocm) {
  EXPECT_EQ(parseBackendOverride("hip"), (std::vector<std::string>{"rocm"}));
  EXPECT_EQ(
      parseBackendOverride("hip,rocm"), (std::vector<std::string>{"rocm"}));
  EXPECT_EQ(
      parseBackendOverride("cuda,HIP"),
      (std::vector<std::string>{"cuda", "rocm"}));
}

// A blank value means the key was not configured, but a value made only of
// separators is a mistake and must be as loud as a misspelled name.
TEST_F(BackendSelectionTest, ParseBackendOverrideRejectsAValueNamingNothing) {
  EXPECT_THROW(parseBackendOverride(","), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride(",,"), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride(" , "), qvac_errors::StatusError);
  EXPECT_TRUE(parseBackendOverride("   ").empty());
}

// ---- tryBackendOverrideFromMap ----

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
      {"backend", "cuda,vulkan"}, {"device", "gpu"}};
  auto families = tryBackendOverrideFromMap(config);
  EXPECT_EQ(families, (std::vector<std::string>{"cuda", "vulkan"}));
  // Must be erased, otherwise it reaches llama.cpp's argument parser.
  EXPECT_EQ(config.count("backend"), 0u);
  EXPECT_EQ(config.count("device"), 1u);
}

TEST_F(BackendSelectionTest, TryBackendOverrideFromMapAbsentIsEmpty) {
  std::unordered_map<std::string, std::string> config{{"device", "gpu"}};
  EXPECT_TRUE(tryBackendOverrideFromMap(config).empty());
}

TEST_F(BackendSelectionTest, TryBackendOverrideFromMapPropagatesThrow) {
  std::unordered_map<std::string, std::string> config{{"backend", "nope"}};
  EXPECT_THROW(tryBackendOverrideFromMap(config), qvac_errors::StatusError);
}

// device 'cpu' with a backend override must land on CPU quietly: no devices are
// enumerated, so the override has nothing to match and must not be treated as
// an error.
TEST_F(BackendSelectionTest, OverrideIgnoredWhenPreferredCpu) {
  mockBackend.addDevice(createGPUDevice(NVIDIA_DESC, CUDA0_BACK));
  auto result = chooseWithOverride(mockBackend, {"cuda"}, BackendType::CPU);
  EXPECT_EQ(result.first, BackendType::CPU);
  EXPECT_EQ(result.second, "none");
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

// qvac-fabric keeps at most one iGPU and only when no discrete GPU exists, so
// two iGPUs of the same registry must not both land in the list.
TEST_F(BackendSelectionTest, SplitModeDeviceNamesKeepsAtMostOneIgpu) {
  MockDevice igpu0(
      "intel arc", "Vulkan0", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan");
  MockDevice igpu1(
      "intel arc", "Vulkan1", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan");
  mockBackend.addDevice(
      createGPUDeviceInRegistry(NVIDIA_DESC, CUDA0_BACK, CUDA_REG));
  mockBackend.addDevice(std::move(igpu0));
  mockBackend.addDevice(std::move(igpu1));
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

// ---- getTensorSplitDeviceNames ----
//
// QVAC-24253: the explicit device list for LLAMA_SPLIT_MODE_TENSOR.
//
// qvac-fabric's tensor branch selects devices with no type filter and no
// dedupe, so without this list it recruits integrated GPUs alongside discrete
// ones and shards a physical GPU registered by two backends twice. These pin
// the filtering the addon does on fabric's behalf.

TEST_F(BackendSelectionTest, TensorDevices_NoDevices_ReturnsEmpty) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_TRUE(getTensorSplitDeviceNames(bckI).empty());
}

TEST_F(BackendSelectionTest, TensorDevices_OnlyCpuAndAccel_ReturnsEmpty) {
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  mockBackend.addDevice(createACCELDevice("accelerate", "blas"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_TRUE(getTensorSplitDeviceNames(bckI).empty());
}

// The headline case: a discrete + integrated host must not put weights or KV
// on the iGPU, because tensor parallelism paces the model by its slowest
// participant.
TEST_F(BackendSelectionTest, TensorDevices_ExcludesIgpuWhenDiscretePresent) {
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", "vulkan0"));
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090 #2", "vulkan1"));
  mockBackend.addDevice(createIGPUDevice("Intel UHD 770", "vulkan2"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getTensorSplitDeviceNames(bckI),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

// An iGPU-only host still gets tensor mode rather than nothing.
TEST_F(BackendSelectionTest, TensorDevices_FallsBackToIgpuWhenNoDiscrete) {
  mockBackend.addDevice(createIGPUDevice("Intel UHD 770", "vulkan0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getTensorSplitDeviceNames(bckI), (std::vector<std::string>{"vulkan0"}));
}

// One physical GPU registered by both Vulkan and HIP under GGML_BACKEND_DL
// must be listed once, or it receives two shards. Same device_id, same
// description — this is what a dual-registered card actually looks like.
TEST_F(BackendSelectionTest, TensorDevices_DedupesDualRegisteredGpu) {
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("AMD Radeon 8060S", "vulkan0"), "0000:03:00.0"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("AMD Radeon 8060S", "rocm0"), "0000:03:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getTensorSplitDeviceNames(bckI), (std::vector<std::string>{"vulkan0"}));
}

// Two identical cards: Vulkan reports the SAME description for both and
// distinguishes them only by device_id (PCI bus id). Deduping on description
// would silently collapse this to one device — which is the canonical
// tensor-parallel setup, so it must not happen.
TEST_F(BackendSelectionTest, TensorDevices_KeepsTwoIdenticalCards) {
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA GeForce RTX 4090", "vulkan0"), "0000:01:00.0"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA GeForce RTX 4090", "vulkan1"), "0000:02:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getTensorSplitDeviceNames(bckI),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

// A null device_id cannot be deduped against, so the device is kept —
// dropping a real GPU is worse than tolerating a duplicate. Mirrors fabric,
// whose find_if only matches when both ids are non-null.
TEST_F(BackendSelectionTest, TensorDevices_KeepsDevicesWithoutDeviceId) {
  mockBackend.addDevice(createGPUDevice("Some GPU", "vulkan0"));
  mockBackend.addDevice(createGPUDevice("Some GPU", "vulkan1"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getTensorSplitDeviceNames(bckI),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

// ggml types RPC devices as GPU (ggml-rpc.cpp, with a TODO). qvac-fabric
// segregates them so they do not count as discrete GPUs — otherwise the local
// iGPU is dropped on an iGPU + RPC host. chooseBackend already skips RPC; this
// enumeration must too.
TEST_F(BackendSelectionTest, TensorDevices_ExcludesRpcDevices) {
  mockBackend.addDevice(
      MockDevice("remote", "rpc0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA RTX 4090", "vulkan0"), "0000:01:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getTensorSplitDeviceNames(bckI), (std::vector<std::string>{"vulkan0"}));
}

// The case fabric's comment calls out by name: an RPC device must not make the
// discrete bucket non-empty and displace the host's own integrated GPU.
TEST_F(BackendSelectionTest, TensorDevices_RpcDoesNotDisplaceLocalIgpu) {
  mockBackend.addDevice(
      MockDevice("remote", "rpc0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  mockBackend.addDevice(withDeviceId(
      createIGPUDevice("Intel UHD 770", "vulkan0"), "0000:00:02.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getTensorSplitDeviceNames(bckI), (std::vector<std::string>{"vulkan0"}));
}

// ---- CUDA PTX JIT cache warning (QVAC-24470) ----
//
// Only the policy is pinned here. The environment-reading overload is
// deliberately not under test: it exists to touch getenv and the filesystem,
// which is exactly what these tests must not do.

TEST_F(BackendSelectionTest, JitCache_WritableCacheDir_NoWarning) {
  backend_selection::JitCacheEnv env;
  env.haveCacheDir = true;
  env.cacheDirWritable = true;
  EXPECT_FALSE(backend_selection::shouldWarnAboutJitCache(env));
}

TEST_F(BackendSelectionTest, JitCache_NoCacheDir_Warns) {
  // No HOME and no CUDA_CACHE_PATH, so the driver has nowhere to persist the
  // JIT result and re-compiles on every start.
  backend_selection::JitCacheEnv env;
  env.haveCacheDir = false;
  env.cacheDirWritable = false;
  EXPECT_TRUE(backend_selection::shouldWarnAboutJitCache(env));
}

TEST_F(BackendSelectionTest, JitCache_ReadOnlyCacheDir_Warns) {
  // The container case: HOME resolves but nothing under it can be written.
  backend_selection::JitCacheEnv env;
  env.haveCacheDir = true;
  env.cacheDirWritable = false;
  EXPECT_TRUE(backend_selection::shouldWarnAboutJitCache(env));
}

// CUDA_CACHE_DISABLE outranks a perfectly good directory, so the disable flag
// has to be checked before writability rather than after.
TEST_F(BackendSelectionTest, JitCache_DisabledBeatsWritableDir_Warns) {
  backend_selection::JitCacheEnv env;
  env.cacheDisabled = true;
  env.haveCacheDir = true;
  env.cacheDirWritable = true;
  EXPECT_TRUE(backend_selection::shouldWarnAboutJitCache(env));
}

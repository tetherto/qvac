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

  MockDevice(
      std::string&& desc, std::string&& backend,
      enum ggml_backend_dev_type devType, std::string&& reg = "standard")
      : description(std::move(desc)), backend_name(std::move(backend)),
        regName(std::move(reg)), type(devType) {}
};

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
        &MockBackendInterface::static_llamaLogCallback};
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

  static enum ggml_backend_dev_type static_dev_type(ggml_backend_dev_t dev) {
    if (!currentInstance)
      return GGML_BACKEND_DEVICE_TYPE_CPU;
    MockDevice* mock_dev = reinterpret_cast<MockDevice*>(dev);
    if (mock_dev) {
      return mock_dev->type;
    }
    return GGML_BACKEND_DEVICE_TYPE_CPU;
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

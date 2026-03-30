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
constexpr const char* MALI_DESC = "Mali-G715";

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
  mockBackend.addDevice(createGPUDevice(MALI_DESC, OPENCL_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, OnlyVulkanMaliChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, VulkanIGPU) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, VulkanGPUOverIGPUWhenGPUBack) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan1");
}

TEST_F(BackendSelectionTest, VulkanGPUOverIGPUWhenIGPUBack) {
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN1_BACK));
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

TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegerIndex) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));

  MainGpu mainGpu = 0;
  expectChosen(mockBackend, BackendType::GPU, "vulkan0", mainGpu);
}

TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegrated) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));

  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosen(mockBackend, BackendType::GPU, "vulkan0", mainGpu);
}

TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuDedicated) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));

  MainGpu mainGpu = MainGpuType::Dedicated;
  expectChosen(mockBackend, BackendType::GPU, "vulkan1", mainGpu);
}

TEST_F(BackendSelectionTest, ChooseBackendWithMainGpuIntegerIndexOne) {
  mockBackend.addDevice(createIGPUDevice(MALI_DESC, VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice(MALI_DESC, VULKAN1_BACK));

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

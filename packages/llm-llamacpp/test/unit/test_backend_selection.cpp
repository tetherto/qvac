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
  /// `ggml_backend_dev_props::device_id` — the PCI bus id for Vulkan, unique
  /// per physical card. Empty means ggml reported null, which is the "cannot
  /// dedupe, keep it" case. Descriptions are NOT unique: Vulkan reports the
  /// raw device name, identical across identical cards.
  std::string deviceId;
  /// Index of the device whose `ggml_backend_reg_t` this device reports. Unset
  /// means "my own", which is the one-registry-per-device default. Registry
  /// IDENTITY, not its name, is what the iGPU retention rule compares, so a
  /// shared registry can only be modelled by pointing two devices at one
  /// handle.
  std::optional<size_t> regAliasIndex;

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

static MockDevice withRegistryOf(MockDevice device, size_t deviceIndex) {
  device.regAliasIndex = deviceIndex;
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
  std::vector<std::pair<ggml_log_level, std::string>> logs;
  // Store string results to ensure they persist during function calls
  mutable std::deque<std::string> string_storage;

  // Static pointer for function pointer callbacks (thread-safe for tests)
  static thread_local MockBackendInterface* currentInstance;

  void addDevice(const MockDevice& device) { devices.push_back(device); }

  void clearDevices() {
    devices.clear();
    string_storage.clear();
    logs.clear();
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
        &MockBackendInterface::static_dev_get_props,
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
    // One registry per device unless the device aliases another's, resolved
    // through the live vector so a reallocation cannot leave a stale pointer.
    MockDevice* mock_dev = reinterpret_cast<MockDevice*>(dev);
    if (currentInstance != nullptr && mock_dev != nullptr &&
        mock_dev->regAliasIndex.has_value() &&
        mock_dev->regAliasIndex.value() < currentInstance->devices.size()) {
      return reinterpret_cast<ggml_backend_reg_t>(
          &currentInstance->devices[mock_dev->regAliasIndex.value()]);
    }
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

  static void static_llamaLogCallback(
      ggml_log_level level, const char* text, void* userData) {
    if (currentInstance != nullptr) {
      currentInstance->logs.emplace_back(level, text != nullptr ? text : "");
    }
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

void expectChosenForPreference(
    MockBackendInterface& mockBackend, BackendType preferredBackend,
    BackendType expectedBackend, const std::string& expectedBackendName,
    const std::optional<MainGpu>& mainGpu = std::nullopt) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  auto result = chooseBackend(preferredBackend, bckI, nullptr, mainGpu);
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

TEST_F(BackendSelectionTest, ShippingFamiliesAreEligibleByRegistryIdentity) {
  for (const char* registry : {"Vulkan", "MTL", "OpenCL"}) {
    mockBackend.clearDevices();
    const std::string description =
        std::string(registry) == "OpenCL" ? ADRENO_DESC : "supported GPU";
    mockBackend.addDevice(MockDevice(
        std::string(description),
        "SomeGpu",
        GGML_BACKEND_DEVICE_TYPE_GPU,
        std::string(registry)));
    expectChosen(mockBackend, BackendType::GPU, "somegpu");
  }
}

TEST_F(BackendSelectionTest, FamilyDeviceNameWorksWithForeignRegistry) {
  mockBackend.addDevice(MockDevice(
      "NVIDIA RTX 4090", "CUDA0", GGML_BACKEND_DEVICE_TYPE_GPU, "Plugin"));
  expectChosen(mockBackend, BackendType::GPU, "cuda0");
}

// The OpenCL bucket is keyed on the backend family (registry or device name),
// the same predicate that admits the device. A device the OpenCL registry names
// after the GPU must still land in that bucket, or the Adreno rules that clear
// it would miss the device.
TEST_F(BackendSelectionTest, OpenClRegistryDeviceLandsInOpenClBucket) {
  mockBackend.addDevice(MockDevice(
      ADRENO_DESC, "Adreno0", GGML_BACKEND_DEVICE_TYPE_GPU, "OpenCL"));
  mockBackend.addDevice(createIGPUDevice(ADRENO_DESC, VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "adreno0");
  EXPECT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& log) {
    return log.second == "Chosen GPU OpenCL";
  }));
}

TEST_F(BackendSelectionTest, OpenClRegistryDeviceIsConsideredUnderMainGpuType) {
  mockBackend.addDevice(MockDevice(
      ADRENO_DESC, "Adreno0", GGML_BACKEND_DEVICE_TYPE_GPU, "OpenCL"));
  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosen(mockBackend, BackendType::GPU, "adreno0", mainGpu);
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

TEST_F(BackendSelectionTest, RocmOnlyFallsBackToCpu) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "ROCm0"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
  ASSERT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& log) {
    return log.first == GGML_LOG_LEVEL_WARN &&
           log.second.find("ROCm0 (standard)") != std::string::npos;
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

// A refused device is recorded before the main-gpu type filter, so the
// CPU-fallback warning still names it when `integrated`/`dedicated` would have
// skipped its type anyway.
TEST_F(BackendSelectionTest, MainGpuIntegratedWarnsAboutRefusedDiscreteGpu) {
  mockBackend.addDevice(createGPUDevice("AMD Radeon", "ROCm0"));
  MainGpu mainGpu = MainGpuType::Integrated;
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", mainGpu);
  ASSERT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& log) {
    return log.first == GGML_LOG_LEVEL_WARN &&
           log.second.find("ROCm0 (standard)") != std::string::npos;
  }));
}

TEST_F(BackendSelectionTest, MainGpuDedicatedWarnsAboutRefusedIntegratedGpu) {
  mockBackend.addDevice(createIGPUDevice("AMD Radeon", "ROCm0"));
  MainGpu mainGpu = MainGpuType::Dedicated;
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none", mainGpu);
  ASSERT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& log) {
    return log.first == GGML_LOG_LEVEL_WARN &&
           log.second.find("ROCm0 (standard)") != std::string::npos;
  }));
}

TEST_F(BackendSelectionTest, RegistryFamilyNamesRequireExactIdentity) {
  mockBackend.addDevice(MockDevice(
      "Future GPU", "Future0", GGML_BACKEND_DEVICE_TYPE_GPU, "NotVulkan"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
}

TEST_F(BackendSelectionTest, DeviceFamilyNamesRequireKnownPrefixes) {
  mockBackend.addDevice(MockDevice(
      "Future GPU", "NotVulkan0", GGML_BACKEND_DEVICE_TYPE_GPU, "Future"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
}

// MUSA (Moore Threads) is a real ggml backend that this addon does not ship,
// and it is nowhere in the allowlist — named explicitly here rather than left
// to the generic unknown-family cases, because "musa" shares no prefix with
// any eligible family and a future allowlist edit must not admit it silently.
// The matcher reads two identities, so both must reject it: the device name...
TEST_F(BackendSelectionTest, MusaDeviceNameFallsBackToCpu) {
  mockBackend.addDevice(createGPUDevice("MTT S80", "MUSA0"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
  ASSERT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& log) {
    return log.first == GGML_LOG_LEVEL_WARN &&
           log.second.find("MUSA0 (standard)") != std::string::npos;
  }));
}

// ...and the registry name, which alone would admit a device the registry
// names after the GPU.
TEST_F(BackendSelectionTest, MusaRegistryNameFallsBackToCpu) {
  mockBackend.addDevice(
      MockDevice("MTT S80", "MttGpu0", GGML_BACKEND_DEVICE_TYPE_GPU, "MUSA"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
  ASSERT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& log) {
    return log.first == GGML_LOG_LEVEL_WARN &&
           log.second.find("MttGpu0 (MUSA)") != std::string::npos;
  }));
}

// The allowlist runs on IGPU-typed devices too (AMD APUs register their
// integrated graphics through ROCm/HIP), and every other ROCm fixture here is
// GPU-typed. An integrated ROCm device must be excluded just the same.
TEST_F(BackendSelectionTest, IntegratedRocmIsExcluded) {
  mockBackend.addDevice(createIGPUDevice("AMD Radeon 780M", "ROCm0"));
  expectChosenForPreference(
      mockBackend, BackendType::GPU, BackendType::CPU, "none");
  ASSERT_TRUE(std::ranges::any_of(mockBackend.logs, [](const auto& log) {
    return log.first == GGML_LOG_LEVEL_WARN &&
           log.second.find("ROCm0 (standard)") != std::string::npos;
  }));
}

// Registry position must not decide eligibility. In both cases the eligible
// device is deliberately the
// IGPU-typed one and the unknown family is GPU-typed, so an unknown wrongly
// admitted would win the bucket ordering (gpuBackends is consulted before
// igpuBackends) and be chosen — asserting vulkan0 therefore proves the
// rejection, not a GPU-over-iGPU preference.
TEST_F(BackendSelectionTest, UnknownGpuBeforeVulkanChoosesVulkan) {
  mockBackend.addDevice(createGPUDevice("Future GPU", "FutureBackend0"));
  mockBackend.addDevice(createIGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
}

TEST_F(BackendSelectionTest, UnknownGpuAfterVulkanChoosesVulkan) {
  mockBackend.addDevice(createIGPUDevice("NVIDIA RTX 4090", VULKAN0_BACK));
  mockBackend.addDevice(createGPUDevice("Future GPU", "FutureBackend0"));
  expectChosen(mockBackend, BackendType::GPU, "vulkan0");
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

TEST_F(BackendSelectionTest, GpuCount_TwoIgpus_ReturnsFabricSelectedOne) {
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

// ---- getSplitDeviceNames ----
//
// QVAC-24253: the explicit device list pinned to --device in every split mode
// (LLAMA_SPLIT_MODE_LAYER, _ROW and _TENSOR).
//
// qvac-fabric's tensor branch selects devices with no type filter and no
// dedupe, so without this list it recruits integrated GPUs alongside discrete
// ones and shards a physical GPU registered by two backends twice. These pin
// the filtering the addon does on fabric's behalf; the list also enforces the
// addon's backend allowlist (isEligibleGpuDevice) in every split mode.

TEST_F(BackendSelectionTest, SplitDevices_NoDevices_ReturnsEmpty) {
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_TRUE(getSplitDeviceNames(bckI).empty());
}

TEST_F(BackendSelectionTest, SplitDevices_OnlyCpuAndAccel_ReturnsEmpty) {
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  mockBackend.addDevice(createACCELDevice("accelerate", "blas"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_TRUE(getSplitDeviceNames(bckI).empty());
}

TEST_F(BackendSelectionTest, SplitDevices_ExcludeRocmAndSycl) {
  mockBackend.addDevice(
      MockDevice("AMD Radeon", "ROCm0", GGML_BACKEND_DEVICE_TYPE_GPU, "HIP"));
  mockBackend.addDevice(
      MockDevice("Intel Arc", "SYCL0", GGML_BACKEND_DEVICE_TYPE_GPU, "SYCL"));
  mockBackend.addDevice(createGPUDevice("NVIDIA GPU", VULKAN0_BACK));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI), (std::vector<std::string>{VULKAN0_BACK}));
}

// The headline case: a discrete + integrated host must not put weights or KV
// on the iGPU, because tensor parallelism paces the model by its slowest
// participant.
TEST_F(BackendSelectionTest, SplitDevices_ExcludesIgpuWhenDiscretePresent) {
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090", "vulkan0"));
  mockBackend.addDevice(createGPUDevice("NVIDIA RTX 4090 #2", "vulkan1"));
  mockBackend.addDevice(createIGPUDevice("Intel UHD 770", "vulkan2"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

// The origin rule (upstream llama.cpp #23897): a second iGPU from a DIFFERENT
// backend registry is the same physical device enumerated twice, so it is
// dropped. Both devices share a registry NAME and still have distinct registry
// handles — the rule compares identity, so matching names must not be enough.
// Distinct device_ids keep device_id dedup from being an alternative
// explanation for the single survivor.
TEST_F(BackendSelectionTest, SplitSelectionKeepsOneIgpuPerDistinctRegistry) {
  mockBackend.addDevice(withDeviceId(
      MockDevice(
          "Intel UHD 770", "vulkan0", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan"),
      "0000:00:02.0"));
  mockBackend.addDevice(withDeviceId(
      MockDevice(
          "Intel Iris Xe", "vulkan1", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan"),
      "0000:00:02.1"));
  BackendInterface bckI = mockBackend.toBackendInterface();

  const SplitDeviceSelection selection = getSplitDeviceSelection(bckI);

  // Both were eligible and counted, but only the first is kept.
  EXPECT_EQ(selection.sourceGpuCount, 2U);
  EXPECT_TRUE(selection.rejectedDevices.empty());
  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"vulkan0"}));
  ASSERT_EQ(selection.devices.size(), 1U);
  EXPECT_EQ(selection.devices[0].sourceGpuIndex, 0U);
}

// The exception (upstream llama.cpp #26953): CUDA reports virtual devices as
// integrated GPUs, so every later iGPU sharing the kept one's registry handle
// is a distinct device and must survive. Reachable once fabric builds CUDA.
TEST_F(BackendSelectionTest, SplitSelectionKeepsIgpusSharingOneRegistry) {
  mockBackend.addDevice(withDeviceId(
      MockDevice("NVIDIA GB10", "CUDA0", GGML_BACKEND_DEVICE_TYPE_IGPU, "CUDA"),
      "0000:01:00.0-v0"));
  mockBackend.addDevice(withRegistryOf(
      withDeviceId(
          MockDevice(
              "NVIDIA GB10", "CUDA1", GGML_BACKEND_DEVICE_TYPE_IGPU, "CUDA"),
          "0000:01:00.0-v1"),
      0));
  BackendInterface bckI = mockBackend.toBackendInterface();

  const SplitDeviceSelection selection = getSplitDeviceSelection(bckI);

  EXPECT_EQ(selection.sourceGpuCount, 2U);
  EXPECT_TRUE(selection.rejectedDevices.empty());
  EXPECT_EQ(
      getSplitDeviceNames(bckI), (std::vector<std::string>{"CUDA0", "CUDA1"}));
  ASSERT_EQ(selection.devices.size(), 2U);
  EXPECT_EQ(selection.devices[0].sourceGpuIndex, 0U);
  EXPECT_EQ(selection.devices[1].sourceGpuIndex, 1U);
}

// Retention chains off the most recently KEPT iGPU, not off the most recently
// SEEN one: a dropped device's registry must not become the reference that
// admits a later device sharing it.
TEST_F(BackendSelectionTest, SplitSelectionChainsIgpuRegistryFromLastKept) {
  mockBackend.addDevice(withDeviceId(
      MockDevice("NVIDIA GB10", "CUDA0", GGML_BACKEND_DEVICE_TYPE_IGPU, "CUDA"),
      "0000:01:00.0-v0"));
  mockBackend.addDevice(withDeviceId(
      MockDevice(
          "Intel UHD 770", "vulkan0", GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan"),
      "0000:00:02.0"));
  mockBackend.addDevice(withRegistryOf(
      withDeviceId(
          MockDevice(
              "Intel Iris Xe",
              "vulkan1",
              GGML_BACKEND_DEVICE_TYPE_IGPU,
              "Vulkan"),
          "0000:00:02.1"),
      1));
  BackendInterface bckI = mockBackend.toBackendInterface();

  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"CUDA0"}));
}

// An iGPU-only host still gets tensor mode rather than nothing.
TEST_F(BackendSelectionTest, SplitDevices_FallsBackToIgpuWhenNoDiscrete) {
  mockBackend.addDevice(createIGPUDevice("Intel UHD 770", "vulkan0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"vulkan0"}));
}

TEST_F(BackendSelectionTest, SplitDevices_DedupesDualRegisteredGpu) {
  mockBackend.addDevice(
      withDeviceId(createGPUDevice("Adreno 830", "vulkan0"), "0000:03:00.0"));
  mockBackend.addDevice(
      withDeviceId(createGPUDevice("Adreno 830", "gpuopencl"), "0000:03:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"vulkan0"}));
}

// Two identical cards: Vulkan reports the SAME description for both and
// distinguishes them only by device_id (PCI bus id). Deduping on description
// would silently collapse this to one device — which is the canonical
// tensor-parallel setup, so it must not happen.
TEST_F(BackendSelectionTest, SplitDevices_KeepsTwoIdenticalCards) {
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA GeForce RTX 4090", "vulkan0"), "0000:01:00.0"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA GeForce RTX 4090", "vulkan1"), "0000:02:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

// A null device_id cannot be deduped against, so the device is kept —
// dropping a real GPU is worse than tolerating a duplicate. Mirrors fabric,
// whose find_if only matches when both ids are non-null.
TEST_F(BackendSelectionTest, SplitDevices_KeepsDevicesWithoutDeviceId) {
  mockBackend.addDevice(createGPUDevice("Some GPU", "vulkan0"));
  mockBackend.addDevice(createGPUDevice("Some GPU", "vulkan1"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI),
      (std::vector<std::string>{"vulkan0", "vulkan1"}));
}

TEST_F(BackendSelectionTest, SplitDevices_IncludeRpcDevices) {
  mockBackend.addDevice(
      MockDevice("remote", "rpc0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA RTX 4090", "vulkan0"), "0000:01:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI), (std::vector<std::string>{"rpc0", "vulkan0"}));
}

TEST_F(BackendSelectionTest, SplitDevices_RpcDoesNotSuppressLocalIgpu) {
  mockBackend.addDevice(
      MockDevice("remote", "rpc0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  mockBackend.addDevice(withDeviceId(
      createIGPUDevice("Intel UHD 770", "vulkan0"), "0000:00:02.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI), (std::vector<std::string>{"rpc0", "vulkan0"}));
}

TEST_F(BackendSelectionTest, SplitDevices_RpcIsPrepended) {
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA RTX 4090", "vulkan0"), "0000:01:00.0"));
  mockBackend.addDevice(
      MockDevice("remote", "rpc0", GGML_BACKEND_DEVICE_TYPE_GPU, "RPC"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(
      getSplitDeviceNames(bckI), (std::vector<std::string>{"rpc0", "vulkan0"}));
}

// One physical card registered by both CUDA and Vulkan reports the same PCI
// bus id from each, so it is kept once; the CUDA entry wins by registry order.
TEST_F(BackendSelectionTest, SplitDevices_DedupesCudaAndVulkanAlias) {
  mockBackend.addDevice(withDeviceId(
      MockDevice(
          "NVIDIA RTX 4090", "CUDA0", GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA"),
      "0000:01:00.0"));
  mockBackend.addDevice(withDeviceId(
      createGPUDevice("NVIDIA RTX 4090", "vulkan0"), "0000:01:00.0"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  EXPECT_EQ(getSplitDeviceNames(bckI), (std::vector<std::string>{"CUDA0"}));
}

// ggml-cuda suffixes the PCI bus id with -v<N> for virtual (MPS/MIG) devices
// and fabric compares device_id verbatim, so two such entries are two devices.
TEST_F(BackendSelectionTest, SplitDevices_KeepsVirtualCudaDevices) {
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

// sourceGpuIndex is the ordinal among GPU/IGPU devices, not the registry
// index: CPU and ACCEL entries interleaved with the GPUs must not shift it.
TEST_F(BackendSelectionTest, SplitDevices_TracksRawGpuIndices) {
  mockBackend.addDevice(createCPUDevice("cpu", "cpu"));
  mockBackend.addDevice(createGPUDevice("NVIDIA GPU", "vulkan0"));
  mockBackend.addDevice(createACCELDevice("accelerate", "blas"));
  mockBackend.addDevice(
      MockDevice("AMD Radeon", "ROCm0", GGML_BACKEND_DEVICE_TYPE_GPU, "HIP"));
  mockBackend.addDevice(createGPUDevice("NVIDIA GPU", "vulkan1"));
  BackendInterface bckI = mockBackend.toBackendInterface();
  const SplitDeviceSelection selection = getSplitDeviceSelection(bckI);
  ASSERT_EQ(selection.devices.size(), 2U);
  EXPECT_EQ(selection.sourceGpuCount, 3U);
  EXPECT_EQ(selection.devices[0].sourceGpuIndex, 0U);
  EXPECT_EQ(selection.devices[1].sourceGpuIndex, 2U);
}

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <ggml-backend.h>
#include <gtest/gtest.h>
#include <whisper.h>

#include "model-interface/bci/BCIModel.hpp"

namespace {
using qvac_lib_inference_addon_bci::BCIConfig;
using qvac_lib_inference_addon_bci::BCIModel;

struct TestDevice {
  enum ggml_backend_dev_type type;
  const char* backend;
  const char* description;
};

struct LoadState {
  std::vector<TestDevice*> devices;
  std::vector<whisper_context_params> loads;
  int frees = 0;
  int warmups = 0;
};

LoadState g_loadState;

TestDevice* testDevice(ggml_backend_dev_t device) {
  return reinterpret_cast<TestDevice*>(device);
}

// Capture the production logger without relying on gtest's internal API.
class CaptureLogs {
public:
  CaptureLogs() : previous_(std::cout.rdbuf(output_.rdbuf())) {}
  ~CaptureLogs() { std::cout.rdbuf(previous_); }
  std::string str() const { return output_.str(); }

private:
  std::ostringstream output_;
  std::streambuf* previous_;
};
} // namespace

// These names are the GNU linker wrapping ABI, not application identifiers.
// NOLINTBEGIN(readability-identifier-naming)
extern "C" {
size_t __wrap_ggml_backend_dev_count() { return g_loadState.devices.size(); }
ggml_backend_dev_t __wrap_ggml_backend_dev_get(size_t index) {
  return reinterpret_cast<ggml_backend_dev_t>(g_loadState.devices.at(index));
}
enum ggml_backend_dev_type
__wrap_ggml_backend_dev_type(ggml_backend_dev_t device) {
  return testDevice(device)->type;
}
ggml_backend_reg_t
__wrap_ggml_backend_dev_backend_reg(ggml_backend_dev_t device) {
  return reinterpret_cast<ggml_backend_reg_t>(device);
}
const char* __wrap_ggml_backend_reg_name(ggml_backend_reg_t registry) {
  return reinterpret_cast<TestDevice*>(registry)->backend;
}
const char* __wrap_ggml_backend_dev_name(ggml_backend_dev_t device) {
  return testDevice(device)->description;
}
const char* __wrap_ggml_backend_dev_description(ggml_backend_dev_t device) {
  return testDevice(device)->description;
}
void __wrap_ggml_backend_dev_memory(
    ggml_backend_dev_t, size_t* free, size_t* total) {
  *free = 1024U * 1024U;
  *total = 2U * 1024U * 1024U;
}
void __wrap_ggml_backend_load_all() {}
void __wrap_ggml_backend_load_all_from_path(const char*) {}

whisper_context* __wrap_whisper_init_from_file_with_params(
    const char*, whisper_context_params params) {
  g_loadState.loads.push_back(params);
  return reinterpret_cast<whisper_context*>(new int(0));
}
void __wrap_whisper_free(whisper_context* context) {
  ++g_loadState.frees;
  delete reinterpret_cast<int*>(context);
}
int __wrap_whisper_full(
    whisper_context*, whisper_full_params, const float*, int) {
  ++g_loadState.warmups;
  return 0;
}
}
// NOLINTEND(readability-identifier-naming)

namespace {
class BCIModelLoadTest : public ::testing::TestWithParam<const char*> {
protected:
  void SetUp() override {
    g_loadState = {};
    g_loadState.devices = {&cpu_, nullptr, &dedicated_, &integrated_};
    // Minimal valid embedder, with no days/months or weights. Inference is
    // stubbed, but the loader still parses the real embedder file.
    embedderPath_ =
        std::filesystem::temp_directory_path() /
        ("bci-load-" + std::to_string(reinterpret_cast<uintptr_t>(this)) +
         ".bin");
    const std::array<uint32_t, 15> embedder{
        0x42434945U, 1U, 1U, 1U, 3U, 3U, 2U, 0U, 0U, 1U};
    std::ofstream file(embedderPath_, std::ios::binary);
    file.write(
        reinterpret_cast<const char*>(embedder.data()), sizeof(embedder));
    ASSERT_TRUE(file.good());
    config_.embedderPath = embedderPath_.string();
    config_.whisperContextCfg["model"] = std::string("test-model.bin");
    config_.whisperContextCfg["use_gpu"] = true;
  }

  void TearDown() override {
    std::filesystem::remove(embedderPath_);
    g_loadState = {};
  }

  static int64_t stat(const BCIModel& model, const std::string& key) {
    const auto stats = model.runtimeStats();
    const auto it =
        std::find_if(stats.begin(), stats.end(), [&](const auto& entry) {
          return entry.first == key;
        });
    return it == stats.end() ? -1 : std::get<int64_t>(it->second);
  }

  TestDevice cpu_{GGML_BACKEND_DEVICE_TYPE_CPU, "CPU", "CPU"};
  TestDevice dedicated_{GGML_BACKEND_DEVICE_TYPE_GPU, "CUDA", "Discrete GPU"};
  TestDevice integrated_{
      GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan", "Integrated GPU"};
  BCIConfig config_;
  std::filesystem::path embedderPath_;
};

TEST_P(BCIModelLoadTest, ValidSelectorsReachWhisperAndReportSelectedBackend) {
  for (const auto& value :
       {qvac_lib_inference_addon_bci::JSValueVariant{3.0},
        qvac_lib_inference_addon_bci::JSValueVariant{std::string("integrated")},
        qvac_lib_inference_addon_bci::JSValueVariant{
            std::string("dedicated")}}) {
    SCOPED_TRACE(GetParam());
    config_.whisperContextCfg[GetParam()] = value;
    BCIModel model(config_);
    ASSERT_NO_THROW(model.load());
    ASSERT_TRUE(model.isLoaded());
    ASSERT_FALSE(g_loadState.loads.empty());
    const bool dedicated =
        value ==
        qvac_lib_inference_addon_bci::JSValueVariant{std::string("dedicated")};
    EXPECT_TRUE(g_loadState.loads.back().use_gpu);
    EXPECT_EQ(g_loadState.loads.back().gpu_device, dedicated ? 0 : 1);
    EXPECT_EQ(stat(model, "backendDevice"), 1);
    EXPECT_EQ(stat(model, "backendId"), dedicated ? 2 : 3);
  }
}

TEST_P(BCIModelLoadTest, CpuOnlyRegistryPreservesRequestedGpuWarning) {
  for (const bool requestGpu : {true, false}) {
    g_loadState.devices = {nullptr, &cpu_};
    config_.whisperContextCfg["use_gpu"] = requestGpu;
    config_.whisperContextCfg[GetParam()] = std::string("integrated");
    CaptureLogs logs;
    BCIModel model(config_);
    ASSERT_NO_THROW(model.load());
    ASSERT_TRUE(model.isLoaded());
    ASSERT_FALSE(g_loadState.loads.empty());
    EXPECT_FALSE(g_loadState.loads.back().use_gpu);
    EXPECT_EQ(stat(model, "backendDevice"), 0);
    EXPECT_EQ(stat(model, "backendId"), 0);
    EXPECT_EQ(
        logs.str().find("no GGML GPU/IGPU device is registered") !=
            std::string::npos,
        requestGpu);
  }
}

TEST_P(BCIModelLoadTest, AdrenoClassSelectorsKeepOpenclIntegrated) {
  TestDevice vulkan{GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan", "Adreno 740"};
  TestDevice opencl{GGML_BACKEND_DEVICE_TYPE_GPU, "OpenCL", "Adreno 740"};
  g_loadState.devices = {&cpu_, &vulkan, &opencl};
  for (const std::string selector : {"integrated", "dedicated"}) {
    config_.whisperContextCfg[GetParam()] = selector;
    BCIModel model(config_);
    ASSERT_NO_THROW(model.load());
    ASSERT_TRUE(model.isLoaded());
    const bool integrated = selector == "integrated";
    EXPECT_EQ(g_loadState.loads.back().use_gpu, integrated);
    if (integrated) {
      EXPECT_EQ(g_loadState.loads.back().gpu_device, 1);
    }
    EXPECT_EQ(stat(model, "backendDevice"), integrated ? 1 : 0);
    EXPECT_EQ(stat(model, "backendId"), integrated ? 4 : 0);
  }
}

TEST_P(BCIModelLoadTest, SelectorTransitionsRecreateContextOnlyWhenChanged) {
  BCIModel model(config_);
  ASSERT_NO_THROW(model.load());
  ASSERT_EQ(g_loadState.loads.size(), 1);

  config_.whisperContextCfg[GetParam()] = std::string("integrated");
  ASSERT_NO_THROW(model.setConfig(config_));
  ASSERT_EQ(g_loadState.loads.size(), 2);
  EXPECT_EQ(g_loadState.frees, 1);
  EXPECT_EQ(g_loadState.loads.back().gpu_device, 1);

  config_.whisperContextCfg[GetParam()] = std::string("dedicated");
  ASSERT_NO_THROW(model.setConfig(config_));
  ASSERT_EQ(g_loadState.loads.size(), 3);
  EXPECT_EQ(g_loadState.frees, 2);
  EXPECT_EQ(g_loadState.loads.back().gpu_device, 0);

  ASSERT_NO_THROW(model.setConfig(config_));
  EXPECT_EQ(g_loadState.loads.size(), 3);
  EXPECT_EQ(g_loadState.frees, 2);

  config_.whisperContextCfg.erase(GetParam());
  ASSERT_NO_THROW(model.setConfig(config_));
  ASSERT_EQ(g_loadState.loads.size(), 4);
  EXPECT_EQ(g_loadState.frees, 3);
  EXPECT_EQ(g_loadState.loads.back().gpu_device, 0);
  EXPECT_EQ(g_loadState.warmups, 4);
  EXPECT_TRUE(model.isLoaded());
}

INSTANTIATE_TEST_SUITE_P(
    SelectorAliases, BCIModelLoadTest,
    ::testing::Values("main-gpu", "main_gpu"));
} // namespace

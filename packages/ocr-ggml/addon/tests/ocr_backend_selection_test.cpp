#include <algorithm>
#include <vector>

#include <ggml.h>
#include <gtest/gtest.h>

#include "model-interface/OcrBackendSelection.hpp"

// These definitions implement only the GGML boundary used by production
// OcrBackendSelection. The selection algorithm itself is never mocked.
struct ggml_backend_reg {
  const char* name;
};
struct ggml_backend_device {
  const char* name;
  const char* description;
  enum ggml_backend_dev_type type;
  ggml_backend_reg reg;
  bool supportsOps{true};
};
struct ggml_context {};

namespace {
std::vector<ggml_backend_device> g_devices;
ggml_context g_context;
ggml_tensor g_tensor;
using namespace qvac_lib_infer_ocr_ggml;
using namespace qvac_lib_infer_ocr_ggml::ocr_backend_selection;

class OcrBackendSelectionTest : public testing::Test {
protected:
  void SetUp() override {
    g_devices = {
        {"ROCm0", "AMD", GGML_BACKEND_DEVICE_TYPE_GPU, {"ROCm"}},
        {"Vulkan0", "Intel", GGML_BACKEND_DEVICE_TYPE_IGPU, {"Vulkan"}},
        {"CPU", "CPU", GGML_BACKEND_DEVICE_TYPE_CPU, {"CPU"}},
        {"Vulkan1", "NVIDIA", GGML_BACKEND_DEVICE_TYPE_GPU, {"Vulkan"}},
        {"Vulkan2", "Adreno 830", GGML_BACKEND_DEVICE_TYPE_IGPU, {"Vulkan"}},
        {"GPUOpenCL", "Adreno 830", GGML_BACKEND_DEVICE_TYPE_IGPU, {"OpenCL"}},
        {"MTL0", "Apple", GGML_BACKEND_DEVICE_TYPE_IGPU, {"Metal"}},
    };
  }

  BackendSelection
  select(MainGpu mainGpu, BackendDevice backend = BackendDevice::VULKAN) {
    return selectBackendDevice(backend, std::nullopt, mainGpu);
  }
};
} // namespace

extern "C" {
size_t ggml_backend_dev_count() { return g_devices.size(); }
ggml_backend_dev_t ggml_backend_dev_get(size_t index) {
  return &g_devices.at(index);
}
ggml_backend_dev_t ggml_backend_dev_by_type(enum ggml_backend_dev_type type) {
  const auto it =
      std::find_if(g_devices.begin(), g_devices.end(), [type](const auto& d) {
        return d.type == type;
      });
  return it == g_devices.end() ? nullptr : &*it;
}
const char* ggml_backend_dev_name(ggml_backend_dev_t dev) { return dev->name; }
const char* ggml_backend_dev_description(ggml_backend_dev_t dev) {
  return dev->description;
}
enum ggml_backend_dev_type ggml_backend_dev_type(ggml_backend_dev_t dev) {
  return dev->type;
}
ggml_backend_reg_t ggml_backend_dev_backend_reg(ggml_backend_dev_t dev) {
  return &dev->reg;
}
const char* ggml_backend_reg_name(ggml_backend_reg_t reg) { return reg->name; }
bool ggml_backend_dev_supports_op(ggml_backend_dev_t dev, const ggml_tensor*) {
  return dev->supportsOps;
}
size_t ggml_tensor_overhead() { return sizeof(ggml_tensor); }
ggml_context* ggml_init(ggml_init_params) { return &g_context; }
void ggml_free(ggml_context*) {}
ggml_tensor* ggml_new_tensor_4d(
    ggml_context*, enum ggml_type, int64_t, int64_t, int64_t, int64_t) {
  return &g_tensor;
}
ggml_tensor* ggml_pool_2d(
    ggml_context*, ggml_tensor*, enum ggml_op_pool, int, int, int, int, float,
    float) {
  return &g_tensor;
}
}

TEST_F(
    OcrBackendSelectionTest,
    DefaultPrefersDedicatedAndLegacyIndexStillUsesFilteredOrder) {
  EXPECT_EQ(selectBackendDevice(BackendDevice::VULKAN).deviceIndex, 3);
  EXPECT_EQ(selectBackendDevice(BackendDevice::VULKAN, 0).deviceIndex, 1);
  EXPECT_EQ(selectBackendDevice(BackendDevice::VULKAN, 1).deviceIndex, 3);
  EXPECT_TRUE(selectBackendDevice(BackendDevice::VULKAN, 99).selectedIsCpu());
}

TEST_F(OcrBackendSelectionTest, RawIndexNeverShiftsAfterBackendFiltering) {
  EXPECT_EQ(select(1).deviceIndex, 1);
  EXPECT_EQ(select(3).deviceIndex, 3);
  const auto excluded = select(0);
  EXPECT_TRUE(excluded.selectedIsCpu());
  EXPECT_FALSE(excluded.fallbackReason.empty());
  EXPECT_TRUE(
      select(2).selectedIsCpu()); // raw CPU index cannot select another GPU
  EXPECT_TRUE(select(5).selectedIsCpu()); // OpenCL index is not Vulkan
}

TEST_F(OcrBackendSelectionTest, ExplicitClassIsStrict) {
  EXPECT_EQ(select(MainGpuClass::DEDICATED).deviceIndex, 3);
  EXPECT_EQ(select(MainGpuClass::INTEGRATED).deviceIndex, 1);
  g_devices[3].type = GGML_BACKEND_DEVICE_TYPE_IGPU;
  EXPECT_TRUE(select(MainGpuClass::DEDICATED).selectedIsCpu());
  g_devices[1].type = g_devices[3].type = GGML_BACKEND_DEVICE_TYPE_GPU;
  EXPECT_TRUE(
      select(MainGpuClass::INTEGRATED).selectedIsCpu()); // Adreno is excluded
}

TEST_F(OcrBackendSelectionTest, OutOfRangeWarnsAndUsesDefaultSelection) {
  testing::internal::CaptureStderr();
  EXPECT_EQ(select(99).deviceIndex, 3);
  EXPECT_EQ(select(-1).deviceIndex, 3);
  const auto warning = testing::internal::GetCapturedStderr();
  EXPECT_NE(warning.find("99 is out of range"), std::string::npos);
  EXPECT_NE(warning.find("-1 is out of range"), std::string::npos);
}

TEST_F(OcrBackendSelectionTest, SafetyGuardsApplyToRawIndicesAndClasses) {
  EXPECT_TRUE(select(4).selectedIsCpu()); // Adreno Vulkan
  EXPECT_EQ(
      select(5, BackendDevice::OPENCL).deviceIndex,
      5); // sound OpenCL path
  g_devices[3].supportsOps = false;
  EXPECT_TRUE(select(3).selectedIsCpu());
  EXPECT_TRUE(select(MainGpuClass::DEDICATED).selectedIsCpu());
  EXPECT_NE(select(3).fallbackReason.find("OCR vision ops"), std::string::npos);
}

TEST_F(OcrBackendSelectionTest, MetalAndOpenclRespectClassAndRawIndices) {
  EXPECT_EQ(select(6, BackendDevice::METAL).deviceIndex, 6);
  EXPECT_EQ(
      select(MainGpuClass::INTEGRATED, BackendDevice::METAL).deviceIndex, 6);
  EXPECT_TRUE(
      select(MainGpuClass::DEDICATED, BackendDevice::METAL).selectedIsCpu());
  EXPECT_EQ(
      select(MainGpuClass::INTEGRATED, BackendDevice::OPENCL).deviceIndex, 5);
  EXPECT_TRUE(
      select(MainGpuClass::DEDICATED, BackendDevice::OPENCL).selectedIsCpu());
}

TEST_F(OcrBackendSelectionTest, CpuRemainsExplicitAndConflictingSelectorsFail) {
  EXPECT_TRUE(select(3, BackendDevice::CPU).selectedIsCpu());
  EXPECT_TRUE(
      select(MainGpuClass::DEDICATED, BackendDevice::CPU).selectedIsCpu());
  EXPECT_THROW(
      selectBackendDevice(BackendDevice::VULKAN, 0, MainGpu{3}),
      std::invalid_argument);
}

TEST_F(
    OcrBackendSelectionTest,
    CpuFallbackNamesOtherGpuDevicesForUnmatchedRequest) {
  g_devices = {
      {"ROCm0", "AMD MI250", GGML_BACKEND_DEVICE_TYPE_GPU, {"ROCm"}},
      {"SYCL0", "Intel Arc A770", GGML_BACKEND_DEVICE_TYPE_GPU, {"SYCL"}},
      {"MTL0", "Apple", GGML_BACKEND_DEVICE_TYPE_IGPU, {"Metal"}},
      {"CPU", "CPU", GGML_BACKEND_DEVICE_TYPE_CPU, {"CPU"}},
  };
  const auto sel = selectBackendDevice(BackendDevice::VULKAN);
  EXPECT_TRUE(sel.selectedIsCpu());
  EXPECT_NE(
      sel.fallbackReason.find("other GPU-type devices registered"),
      std::string::npos);
  EXPECT_NE(sel.fallbackReason.find("ROCm0 (ROCm)"), std::string::npos);
  EXPECT_NE(sel.fallbackReason.find("SYCL0 (SYCL)"), std::string::npos);
  EXPECT_NE(sel.fallbackReason.find("MTL0 (Metal)"), std::string::npos);
}

#include <limits>
#include <map>
#include <string>
#include <variant>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/MainGpuSelection.hpp"
#include "model-interface/WhisperGpuSelection.hpp"

namespace {
using Value = std::variant<std::monostate, int, double, std::string, bool>;
using Config = std::map<std::string, Value>;
using main_gpu::Device;
using main_gpu::Kind;
using main_gpu::select;

TEST(MainGpuSelection, PreservesRegistryIdentityAcrossCpuAndExcludedSlots) {
  // [CPU, ROCm0 (unsupported), Vulkan0]. Whisper's GPU ordinals are 0 and 1.
  const std::vector<Device> devices{{}, {0, false, false}, {1, false, true}};
  EXPECT_EQ(select(devices, {Kind::Index, 0}).whisperIndex, -1);
  EXPECT_EQ(select(devices, {Kind::Index, 1}).whisperIndex, -1);
  EXPECT_EQ(select(devices, {Kind::Index, 2}).whisperIndex, 1);
}

TEST(MainGpuSelection, DefaultPrefersDedicatedAndClassesAreStrict) {
  const std::vector<Device> devices{{0, true, true}, {1, false, true}};
  EXPECT_EQ(select(devices, {}).whisperIndex, 1);
  EXPECT_EQ(select(devices, {Kind::Integrated}).whisperIndex, 0);
  EXPECT_EQ(select(devices, {Kind::Dedicated}).whisperIndex, 1);
  EXPECT_EQ(select({{0, false, true}}, {Kind::Integrated}).whisperIndex, -1);
  EXPECT_EQ(select({{0, true, true}}, {Kind::Dedicated}).whisperIndex, -1);
  EXPECT_EQ(select({}, {}).whisperIndex, -1);
}

TEST(MainGpuSelection, OutOfRangeWarnsAndUsesDefaultSelection) {
  const std::vector<Device> devices{{0, true, true}, {1, false, true}};
  for (const int index : {-1, 2, 100}) {
    const auto selected = select(devices, {Kind::Index, index});
    EXPECT_TRUE(selected.outOfRange);
    EXPECT_EQ(selected.whisperIndex, 1);
  }
  EXPECT_FALSE(select(devices, {Kind::Index, 0}).outOfRange);
}

TEST(MainGpuSelection, AdrenoGuardCannotRedirectAnExplicitIndex) {
  const std::vector<Device> devices{{0, true, false}, {1, true, true, true}};
  EXPECT_EQ(select(devices, {}).whisperIndex, 1);
  EXPECT_EQ(select(devices, {Kind::Index, 0}).whisperIndex, -1);
  EXPECT_EQ(select(devices, {Kind::Index, 1}).whisperIndex, 1);
  EXPECT_EQ(select(devices, {Kind::Dedicated}).whisperIndex, -1);
}

TEST(MainGpuSelection, ParsesAliasesAndStrictNumericStrings) {
  EXPECT_EQ(main_gpu::parse(Config{{"main-gpu", 2.0}}).index, 2);
  EXPECT_EQ(main_gpu::parse(Config{{"main_gpu", std::string("+2")}}).index, 2);
  EXPECT_EQ(main_gpu::parse(Config{{"main_gpu", std::string("-1")}}).index, -1);
  EXPECT_EQ(
      main_gpu::parse(Config{{"main-gpu", std::string("INTEGRATED")}}).kind,
      Kind::Integrated);
  EXPECT_EQ(main_gpu::parse(Config{{"gpu_device", 1}}).kind, Kind::Automatic);
  for (const Value value :
       {Value{true},
        Value{1.2},
        Value{std::monostate{}},
        Value{std::numeric_limits<double>::infinity()},
        Value{2147483648.0},
        Value{std::string("2junk")},
        Value{std::string("+-1")},
        Value{std::string(" 2")},
        Value{std::string("2147483648")}}) {
    EXPECT_THROW(
        main_gpu::parse(Config({{"main-gpu", value}})), std::invalid_argument);
  }
  EXPECT_THROW(
      main_gpu::parse(Config({{"main-gpu", 0}, {"main_gpu", 0}})),
      std::invalid_argument);
  EXPECT_THROW(
      main_gpu::parse(Config({{"main_gpu", 0}, {"gpu_device", 0}})),
      std::invalid_argument);
}
} // namespace

namespace {
struct MockDevice {
  enum ggml_backend_dev_type type;
  const char* backend;
  const char* description;
  const char* name = nullptr;
};
struct MockRegistry {
  std::vector<const MockDevice*> devices;
  size_t count() const { return devices.size(); }
  const MockDevice* get(size_t i) const { return devices[i]; }
  auto type(const MockDevice* dev) const { return dev->type; }
  const char* backend(const MockDevice* dev) const { return dev->backend; }
  const char* description(const MockDevice* dev) const {
    return dev->description;
  }
  const char* name(const MockDevice* dev) const {
    return dev->name != nullptr ? dev->name : dev->description;
  }
};

TEST(MainGpuRegistry, EnumeratesRawSlotsAndWhisperOrdinalsWithoutRenumbering) {
  const MockDevice cpu{GGML_BACKEND_DEVICE_TYPE_CPU, "CPU", "CPU"};
  const MockDevice rocm{GGML_BACKEND_DEVICE_TYPE_GPU, "ROCm", "Radeon"};
  const MockDevice vulkan{GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan", "Intel"};
  const auto devices =
      main_gpu::registryDevices(MockRegistry{{&cpu, nullptr, &rocm, &vulkan}});
  ASSERT_EQ(devices.size(), 4);
  EXPECT_EQ(devices[0].whisperIndex, -1);
  EXPECT_EQ(devices[1].whisperIndex, -1);
  EXPECT_EQ(devices[2].whisperIndex, 0);
  EXPECT_FALSE(devices[2].eligible);
  EXPECT_EQ(select(devices, {Kind::Index, 2}).whisperIndex, -1);
  EXPECT_EQ(select(devices, {Kind::Index, 3}).whisperIndex, 1);
  EXPECT_EQ(select(devices, {Kind::Integrated}).whisperIndex, 1);
}

TEST(MainGpuRegistry, RecognizesPinnedBackendRegistryNames) {
  for (const char* backend : {"MTL", "Metal", "CUDA", "Vulkan", "OpenCL"}) {
    const MockDevice gpu{GGML_BACKEND_DEVICE_TYPE_GPU, backend, "GPU"};
    const auto devices = main_gpu::registryDevices(MockRegistry{{&gpu}});
    EXPECT_EQ(select(devices, {}).whisperIndex, 0) << backend;
  }
  for (const char* backend : {"RPC", "ROCm", "SYCL", "CUDAevil", "notmetal"}) {
    const MockDevice gpu{GGML_BACKEND_DEVICE_TYPE_GPU, backend, "GPU"};
    const auto devices = main_gpu::registryDevices(MockRegistry{{&gpu}});
    EXPECT_EQ(select(devices, {Kind::Index, 0}).whisperIndex, -1) << backend;
  }
}

TEST(MainGpuRegistry, AdrenoGuardRequiresOpenclBackendAndAdrenoDescription) {
  const MockDevice vulkan{
      GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan", "Adreno 740"};
  const MockDevice opencl{GGML_BACKEND_DEVICE_TYPE_GPU, "OpenCL", "Adreno 740"};
  auto devices = main_gpu::registryDevices(MockRegistry{{&vulkan, &opencl}});
  EXPECT_EQ(select(devices, {}).whisperIndex, 1);
  EXPECT_EQ(select(devices, {Kind::Index, 0}).whisperIndex, -1);
  EXPECT_EQ(select(devices, {Kind::Index, 1}).whisperIndex, 1);
  EXPECT_TRUE(devices[1].integrated);
  EXPECT_EQ(select(devices, {Kind::Integrated}).whisperIndex, 1);
  EXPECT_EQ(select(devices, {Kind::Dedicated}).whisperIndex, -1);

  const MockDevice rpc{GGML_BACKEND_DEVICE_TYPE_GPU, "RPC", "Adreno 740"};
  devices = main_gpu::registryDevices(MockRegistry{{&vulkan, &rpc}});
  EXPECT_EQ(select(devices, {Kind::Index, 0}).whisperIndex, 0);
  const MockDevice mali{GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan", "Mali"};
  const MockDevice intel{GGML_BACKEND_DEVICE_TYPE_GPU, "OpenCL", "Intel"};
  devices = main_gpu::registryDevices(MockRegistry{{&mali, &intel}});
  EXPECT_EQ(select(devices, {Kind::Index, 0}).whisperIndex, 0);
}

TEST(MainGpuRegistry, CpuFallbackNamesEveryRefusedGpuTypeDevice) {
  const MockDevice rocm{
      GGML_BACKEND_DEVICE_TYPE_GPU, "ROCm", "Radeon 7900", "rocm0"};
  const MockDevice sycl{
      GGML_BACKEND_DEVICE_TYPE_GPU, "SYCL", "Intel Arc A770", "sycl0"};
  const MockDevice adrenoVulkan{
      GGML_BACKEND_DEVICE_TYPE_IGPU, "Vulkan", "Adreno 740", "vulkan0"};
  const MockDevice adrenoOpencl{
      GGML_BACKEND_DEVICE_TYPE_GPU, "OpenCL", "Adreno 740", "opencl0"};

  const auto refusedOnly =
      main_gpu::registryDevices(MockRegistry{{&rocm, &sycl}});
  const auto fallback = select(refusedOnly, {});
  EXPECT_EQ(fallback.whisperIndex, -1);
  ASSERT_EQ(fallback.refused.size(), 2);
  EXPECT_EQ(fallback.refused[0], "rocm0 (ROCm)");
  EXPECT_EQ(fallback.refused[1], "sycl0 (SYCL)");

  const auto mixed = main_gpu::registryDevices(
      MockRegistry{{&rocm, &adrenoVulkan, &adrenoOpencl}});
  EXPECT_EQ(select(mixed, {}).whisperIndex, 2);
  const auto guarded = select(mixed, {Kind::Index, 1});
  EXPECT_EQ(guarded.whisperIndex, -1);
  ASSERT_EQ(guarded.refused.size(), 2);
  EXPECT_EQ(guarded.refused[0], "rocm0 (ROCm)");
  EXPECT_EQ(guarded.refused[1], "vulkan0 (Vulkan)");

  const auto eligibleOnly =
      main_gpu::registryDevices(MockRegistry{{&adrenoOpencl}});
  EXPECT_TRUE(select(eligibleOnly, {}).refused.empty());
}
} // namespace

#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "utils/BackendSelection.hpp"

using vla_backend_selection::backendNameMatchesFamily;
using vla_backend_selection::DeviceInterface;
using vla_backend_selection::parseAdrenoModel;
using vla_backend_selection::parseBackendOverride;
using vla_backend_selection::pickBestGpuDevice;

TEST(VlaBackendSelection, ParsesAdrenoTrademarkForm) {
  EXPECT_EQ(parseAdrenoModel("Adreno (TM) 830"), 830);
  EXPECT_EQ(parseAdrenoModel("Adreno (TM) 750"), 750);
  EXPECT_EQ(parseAdrenoModel("Adreno (TM) 660"), 660);
}

TEST(VlaBackendSelection, ParsesAdrenoBareForm) {
  EXPECT_EQ(parseAdrenoModel("Adreno 740"), 740);
  EXPECT_EQ(parseAdrenoModel("adreno 730"), 730);
}

TEST(VlaBackendSelection, IsCaseInsensitive) {
  EXPECT_EQ(parseAdrenoModel("ADRENO 830"), 830);
  EXPECT_EQ(parseAdrenoModel("aDrEnO (tm) 740"), 740);
}

TEST(VlaBackendSelection, ReturnsZeroForNonAdreno) {
  EXPECT_EQ(parseAdrenoModel("Mali-G715"), 0);
  EXPECT_EQ(parseAdrenoModel("NVIDIA RTX 4090"), 0);
  EXPECT_EQ(parseAdrenoModel("Apple M1 Pro"), 0);
  EXPECT_EQ(parseAdrenoModel(""), 0);
}

TEST(VlaBackendSelection, ReturnsZeroWhenAdrenoFollowedByNoDigits) {
  EXPECT_EQ(parseAdrenoModel("Adreno"), 0);
  EXPECT_EQ(parseAdrenoModel("Adreno (TM)"), 0);
}

// ---- QVAC-23763: the `backend` override ----
//
// Parsing first, then pickBestGpuDevice() against a fake device list below.

TEST(VlaBackendSelection, ParseBackendOverrideLowercasesAndSplits) {
  EXPECT_EQ(
      parseBackendOverride("CUDA,Vulkan"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideTrimsSpaces) {
  EXPECT_EQ(
      parseBackendOverride(" cuda , vulkan "),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideDropsDuplicates) {
  EXPECT_EQ(
      parseBackendOverride("cuda,cuda,vulkan"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideIgnoresEmptyEntries) {
  EXPECT_EQ(
      parseBackendOverride("cuda,,vulkan,"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideAcceptsHipAndRocm) {
  EXPECT_EQ(
      parseBackendOverride("rocm,hip"), (std::vector<std::string>{"rocm"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideThrowsOnUnknownName) {
  EXPECT_THROW(parseBackendOverride("cudaa"), qvac_errors::StatusError);
}

// ggml's HIP build reports its devices as "ROCm%d", so 'hip' has to arrive at
// the matcher as "rocm" or it pins nothing.
TEST(VlaBackendSelection, ParseBackendOverrideCanonicalisesHipToRocm) {
  EXPECT_EQ(parseBackendOverride("hip"), (std::vector<std::string>{"rocm"}));
  EXPECT_EQ(
      parseBackendOverride("HIP,rocm"), (std::vector<std::string>{"rocm"}));
}

// A blank value means the key was not configured, but a value made only of
// separators is a mistake and must be as loud as a misspelled name.
TEST(VlaBackendSelection, ParseBackendOverrideRejectsAValueNamingNothing) {
  EXPECT_THROW(parseBackendOverride(","), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride(" , "), qvac_errors::StatusError);
  EXPECT_TRUE(parseBackendOverride("   ").empty());
}

// 'cpu' is handled by the addon layer before this is reached, in any case.
TEST(VlaBackendSelection, ParseBackendOverrideRejectsCpuInAnyCase) {
  EXPECT_THROW(parseBackendOverride("CPU"), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride("cpu,vulkan"), qvac_errors::StatusError);
}

TEST(VlaBackendSelection, ParseBackendOverrideRejectsCpu) {
  EXPECT_THROW(parseBackendOverride("cpu"), qvac_errors::StatusError);
}

// llm-llamacpp and embed-llamacpp both carry this case; vla ships on Metal
// too, so the same spelling has to match here.
TEST(VlaBackendSelection, MatchesTheMtlSpellingOfMetal) {
  EXPECT_TRUE(backendNameMatchesFamily("metal0", "metal"));
  EXPECT_TRUE(backendNameMatchesFamily("mtl0", "metal"));
  EXPECT_FALSE(backendNameMatchesFamily("vulkan0", "metal"));
  // Only as a prefix: "mtl" inside another name is not a Metal device.
  EXPECT_FALSE(backendNameMatchesFamily("xmtl0", "metal"));
}

TEST(VlaBackendSelection, MatchesFamilyBySubstring) {
  EXPECT_TRUE(backendNameMatchesFamily("cuda0", "cuda"));
  EXPECT_TRUE(backendNameMatchesFamily("gpuopencl", "opencl"));
  EXPECT_FALSE(backendNameMatchesFamily("rocm0", "cuda"));
}

// createInstance maps a bare 'auto' to no preference; inside a list it must be
// dropped rather than rejected as an unknown family.
TEST(VlaBackendSelection, ParseBackendOverrideAcceptsAutoInAList) {
  EXPECT_EQ(
      parseBackendOverride("auto,cuda"), (std::vector<std::string>{"cuda"}));
  EXPECT_TRUE(parseBackendOverride("auto").empty());
  EXPECT_TRUE(parseBackendOverride(" AUTO ").empty());
}

// A CRLF config value must not throw on an entry that reads as correct.
TEST(VlaBackendSelection, ParseBackendOverrideTrimsCarriageReturns) {
  EXPECT_EQ(
      parseBackendOverride("cuda\r\n,\tvulkan\r"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

// Accepting 'auto' must not weaken this: a value naming nothing is still a
// config mistake.
TEST(VlaBackendSelection, ParseBackendOverrideStillRejectsSeparatorsOnly) {
  EXPECT_THROW(parseBackendOverride(","), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride(" , "), qvac_errors::StatusError);
}

// ---- QVAC-23763: pickBestGpuDevice() over a fake device list ----

namespace {

struct FakeDevice {
  std::string name;
  std::string description;
  enum ggml_backend_dev_type type;
};

// The function-pointer interface has no context argument, so the list the
// callbacks read is a file-level global, set per test.
std::vector<FakeDevice>* gDevices = nullptr;

FakeDevice* asFake(ggml_backend_dev_t dev) {
  return reinterpret_cast<FakeDevice*>(dev);
}

const DeviceInterface kFakeDevices{
    []() { return gDevices->size(); },
    [](size_t i) {
      return reinterpret_cast<ggml_backend_dev_t>(&(*gDevices)[i]);
    },
    [](ggml_backend_dev_t d) { return asFake(d)->type; },
    [](ggml_backend_dev_t d) { return asFake(d)->name.c_str(); },
    [](ggml_backend_dev_t d) { return asFake(d)->description.c_str(); }};

// Name of the picked device, or "" for nullptr (the caller then uses CPU).
std::string pick(
    std::vector<FakeDevice> devices,
    const std::vector<std::string>& backendOverride = {}) {
  gDevices = &devices;
  ggml_backend_dev_t dev = pickBestGpuDevice(kFakeDevices, backendOverride);
  gDevices = nullptr;
  return dev == nullptr ? "" : asFake(dev)->name;
}

constexpr auto kGpu = GGML_BACKEND_DEVICE_TYPE_GPU;
constexpr auto kIgpu = GGML_BACKEND_DEVICE_TYPE_IGPU;
constexpr auto kCpu = GGML_BACKEND_DEVICE_TYPE_CPU;

} // namespace

TEST(VlaBackendSelection, OverrideVulkanBeatsPresentCuda) {
  EXPECT_EQ(
      pick(
          {{"CUDA0", "NVIDIA RTX 4090", kGpu},
           {"Vulkan0", "NVIDIA RTX 4090", kGpu}},
          {"vulkan"}),
      "Vulkan0");
}

TEST(VlaBackendSelection, OverrideRespectsListOrder) {
  EXPECT_EQ(
      pick(
          {{"Vulkan0", "NVIDIA RTX 4090", kGpu},
           {"CUDA0", "NVIDIA RTX 4090", kGpu}},
          {"cuda", "vulkan"}),
      "CUDA0");
}

TEST(VlaBackendSelection, OverrideWithNoMatchFallsBackToDefaultOrder) {
  EXPECT_EQ(
      pick(
          {{"Vulkan0", "NVIDIA RTX 4090", kGpu},
           {"CUDA0", "NVIDIA RTX 4090", kGpu}},
          {"metal"}),
      "CUDA0");
}

TEST(VlaBackendSelection, CudaBeatsRocmByDefault) {
  EXPECT_EQ(
      pick(
          {{"ROCm0", "AMD Radeon 8060S", kIgpu},
           {"CUDA0", "NVIDIA RTX 4090", kGpu}}),
      "CUDA0");
}

TEST(VlaBackendSelection, RocmBeatsVulkanByDefault) {
  EXPECT_EQ(
      pick(
          {{"Vulkan0", "NVIDIA RTX 4090", kGpu},
           {"ROCm0", "AMD Radeon 8060S", kIgpu}}),
      "ROCm0");
}

TEST(VlaBackendSelection, DgpuOverIgpu) {
  EXPECT_EQ(
      pick(
          {{"CPU", "Host CPU", kCpu},
           {"Vulkan0", "Intel Iris Xe", kIgpu},
           {"Vulkan1", "NVIDIA RTX 4090", kGpu}}),
      "Vulkan1");
}

TEST(VlaBackendSelection, IgpuUsedWhenNoDgpu) {
  EXPECT_EQ(
      pick({{"CPU", "Host CPU", kCpu}, {"Vulkan0", "Intel Iris Xe", kIgpu}}),
      "Vulkan0");
}

TEST(VlaBackendSelection, OverrideCannotPickAdrenoVulkan) {
  EXPECT_EQ(pick({{"Vulkan0", "Adreno (TM) 830", kGpu}}, {"vulkan"}), "");
}

TEST(VlaBackendSelection, Adreno830OpenClIgnoresOverride) {
  EXPECT_EQ(
      pick(
          {{"GPUOpenCL", "QUALCOMM Adreno(TM) 830", kGpu},
           {"Vulkan0", "Adreno (TM) 830", kGpu}},
          {"vulkan"}),
      "GPUOpenCL");
}

TEST(VlaBackendSelection, Adreno740Rejected) {
  EXPECT_EQ(
      pick(
          {{"GPUOpenCL", "QUALCOMM Adreno(TM) 740", kGpu},
           {"Vulkan0", "Adreno (TM) 740", kGpu}}),
      "");
}

TEST(VlaBackendSelection, MaliVulkanAccepted) {
  EXPECT_EQ(pick({{"Vulkan0", "Mali-G715", kGpu}}), "Vulkan0");
}

#include <cstdint>
#include <string>
#include <variant>

#include <gtest/gtest.h>

#include "utils/ModelBackendName.hpp"

using qvac_lib_inference_addon_llama::backend_reporting::modelBackendName;

TEST(ModelBackendName, CanonicalizesRuntimeRegistryFamilies) {
  using qvac_lib_inference_addon_llama::backend_reporting::
      canonicalBackendFamily;
  EXPECT_EQ(canonicalBackendFamily("MTL"), "metal");
  EXPECT_EQ(canonicalBackendFamily("CUDA"), "cuda");
}

TEST(ModelBackendName, CpuOnlyAndZeroGpuOffload) {
  EXPECT_EQ(
      modelBackendName({{1024, "cpu", true}, {0, "metal", false}}), "cpu");
}

TEST(ModelBackendName, OmitsCompanionCpuAndPinnedHostBuffers) {
  EXPECT_EQ(
      modelBackendName(
          {{1024, "cpu", true}, {1024, "cuda", true}, {4096, "cuda", false}}),
      "cuda");
}

TEST(ModelBackendName, CountsOnlyCpuAndPinnedHostBuffersAsCpu) {
  using qvac_lib_inference_addon_llama::backend_reporting::holdsCpuWeights;
  // CPU buffers.
  EXPECT_TRUE(holdsCpuWeights(true, true, false));
  // CUDA_Host and Vulkan_Host.
  EXPECT_TRUE(holdsCpuWeights(true, false, true));
  // XDNA_Host: host memory the NPU runs from.
  EXPECT_FALSE(holdsCpuWeights(true, false, false));
  // Device memory, such as CUDA0 or Metal.
  EXPECT_FALSE(holdsCpuWeights(false, false, false));
}

TEST(ModelBackendName, SortsAndDeduplicatesSplitFamilies) {
  EXPECT_EQ(
      modelBackendName(
          {{4096, "vulkan", false},
           {4096, "cuda", false},
           {4096, "cuda", false}}),
      "cuda,vulkan");
  EXPECT_EQ(
      modelBackendName({{4096, "cuda,vulkan", false}, {4096, "opencl", false}}),
      "cuda,opencl,vulkan");
}

TEST(ModelBackendName, LeavesMissingOrUnidentifiedPlacementUnknown) {
  EXPECT_TRUE(modelBackendName({}).empty());
  EXPECT_TRUE(modelBackendName({{0, "metal", false}}).empty());
  EXPECT_TRUE(
      modelBackendName({{1024, "cpu", true}, {1024, "", false}}).empty());
}

TEST(ModelBackendName, AppendsOnlyAKnownNameAsStringStat) {
  using qvac_lib_inference_addon_llama::backend_reporting::appendBackendName;
  qvac_lib_inference_addon_cpp::RuntimeStats stats{
      {"backendDevice", int64_t{1}}};
  appendBackendName(stats, "");
  ASSERT_EQ(stats.size(), 1U);
  appendBackendName(stats, "cuda,vulkan");
  ASSERT_EQ(stats.size(), 2U);
  EXPECT_EQ(stats.back().first, "backendName");
  const auto* name = std::get_if<std::string>(&stats.back().second);
  ASSERT_NE(name, nullptr);
  EXPECT_EQ(*name, "cuda,vulkan");
}

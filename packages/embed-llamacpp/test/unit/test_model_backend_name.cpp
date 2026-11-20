#include <gtest/gtest.h>

#include "utils/ModelBackendName.hpp"

using qvac_lib_inference_addon_embed::backend_reporting::modelBackendName;

TEST(ModelBackendName, CanonicalizesRuntimeRegistryFamilies) {
  using qvac_lib_inference_addon_embed::backend_reporting::
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

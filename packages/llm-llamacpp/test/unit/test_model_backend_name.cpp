#include <memory>

#include <gtest/gtest.h>

#include "utils/ModelBackendName.hpp"

using qvac_lib_inference_addon_llama::backend_reporting::modelBackendName;

TEST(ModelBackendName, CanonicalizesRuntimeRegistryFamilies) {
  using qvac_lib_inference_addon_llama::backend_reporting::
      canonicalBackendFamily;
  EXPECT_EQ(canonicalBackendFamily("MTL"), "metal");
  EXPECT_EQ(canonicalBackendFamily("Metal"), "metal");
  EXPECT_EQ(canonicalBackendFamily("CUDA"), "cuda");
  EXPECT_EQ(canonicalBackendFamily("Vulkan"), "vulkan");
  EXPECT_EQ(canonicalBackendFamily("OpenCL"), "opencl");
  EXPECT_EQ(canonicalBackendFamily("CPU"), "cpu");
  EXPECT_EQ(canonicalBackendFamily("RPC"), "rpc");
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

TEST(ModelBackendName, IgnoresContextAndComputeOnlyDevices) {
  EXPECT_EQ(
      modelBackendName({{1024, "cpu", true}, {0, "vulkan", false}}), "cpu");
}

TEST(ModelBackendName, LeavesMissingOrUnidentifiedPlacementUnknown) {
  EXPECT_TRUE(modelBackendName({}).empty());
  EXPECT_TRUE(modelBackendName({{0, "metal", false}}).empty());
  EXPECT_TRUE(
      modelBackendName({{1024, "cpu", true}, {1024, "", false}}).empty());
}

TEST(ModelBackendName, PreservesRpcFamily) {
  EXPECT_EQ(modelBackendName({{4096, "rpc", false}}), "rpc");
}

TEST(ModelBackendName, MetadataRemainsAvailableAfterItsOwnerReleasesIt) {
  auto owner = std::make_shared<
      qvac_lib_inference_addon_llama::backend_reporting::RuntimeBackendName>();
  owner->set("metal");
  std::shared_ptr<const qvac_lib_inference_addon_llama::backend_reporting::
                      RuntimeBackendName>
      queued = owner;
  owner.reset();
  EXPECT_EQ(queued->get(), "metal");
}

#include <gtest/gtest.h>

#include "model-interface/BackendUtils.hpp"
#include "model-interface/EngineOptions.hpp"

namespace qvac::audiogenggml {
namespace {

TEST(RuntimeOptions, AcestepSelectsPrimaryAndLmIndependently) {
  acestep::AcestepConfig config{};
  config.backend = "CPU";
  config.lmBackend = "WebGPU";
  config.dumpStagesDir = "/existing/debug";
  config.nGpuLayers = 99;

  const auto options = engineOptions(config);
  EXPECT_EQ(options.backend, "CPU");
  EXPECT_EQ(options.lm_backend, "WebGPU");
  EXPECT_EQ(options.dump_stages_dir, "/existing/debug");
  EXPECT_EQ(options.n_gpu_layers, 0);
}

TEST(RuntimeOptions, AcestepUnsetOptionsPreserveNativeDefaults) {
  acestep::AcestepConfig config{};
  config.useGpu = true;
  config.nGpuLayers = 7;
  const auto options = engineOptions(config);
  const tts_cpp::acestep::EngineOptions defaults;
  EXPECT_EQ(options.backend, defaults.backend);
  EXPECT_EQ(options.lm_backend, defaults.lm_backend);
  EXPECT_TRUE(options.dump_stages_dir.empty());
  EXPECT_EQ(options.n_gpu_layers, 7);
}

TEST(RuntimeOptions, MinimaxConditionerKeepsGgmlDeviceSelection) {
  minimax::MinimaxConfig config;
  config.coremlConditionerPath = "/models/conditioner.mlmodelc";
  config.device = "gpu";
  const auto options = engineOptions(config);
  EXPECT_EQ(options.coreml_conditioner_path, config.coremlConditionerPath);
  EXPECT_EQ(options.device, "gpu");
  EXPECT_TRUE(options.coreml_profile_dir.empty());
  EXPECT_TRUE(options.coreml_compute_units.empty());
}

TEST(RuntimeOptions, MinimaxRetainsFullCoreMLAndUseGpuBehavior) {
  minimax::MinimaxConfig config;
  config.coremlProfileDir = "/models/profile";
  config.coremlComputeUnits = "CPU_AND_NE";
  config.useGpu = true;
  const auto options = engineOptions(config);
  EXPECT_EQ(options.coreml_profile_dir, config.coremlProfileDir);
  EXPECT_EQ(options.coreml_compute_units, config.coremlComputeUnits);
  EXPECT_TRUE(options.coreml_conditioner_path.empty());
  EXPECT_EQ(options.device, "auto");
  config.useGpu = false;
  EXPECT_EQ(engineOptions(config).device, "cpu");
}

TEST(RuntimeOptions, BackendIdsMatchPublicNames) {
  EXPECT_EQ(backendIdFromName("CPU"), 0);
  EXPECT_EQ(backendIdFromName("MTL0"), 1);
  EXPECT_EQ(backendIdFromName("CUDA0"), 2);
  EXPECT_EQ(backendIdFromName("Vulkan0"), 3);
  EXPECT_EQ(backendIdFromName("GPUOpenCL"), 4);
  EXPECT_EQ(backendIdFromName("WebGPU"), 5);
  EXPECT_EQ(backendIdFromName("WEBGPU0"), 5);
  EXPECT_EQ(backendIdFromName("unrecognized"), 99);
}

} // namespace
} // namespace qvac::audiogenggml

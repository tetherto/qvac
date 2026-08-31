#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iterator>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

#include <ggml-backend.h>
#include <gmock/gmock.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/LoadFitNormalization.hpp"
#include "test_common.hpp"

namespace lfn = load_fit_normalization;

namespace {

void expectOnlyMappedFieldChanges(
    bool common_params::* sourceField,
    bool lfn::NormalizedFitSnapshot::* snapshotField) {
  common_params baselineParams;
  const auto baselineSnapshot =
      lfn::makeNormalizedFitSnapshot(baselineParams, 0);

  common_params toggledParams;
  toggledParams.*sourceField = !(toggledParams.*sourceField);
  const auto toggledSnapshot = lfn::makeNormalizedFitSnapshot(toggledParams, 0);

  auto expectedSnapshot = baselineSnapshot;
  expectedSnapshot.*snapshotField = !(expectedSnapshot.*snapshotField);
  EXPECT_EQ(toggledSnapshot, expectedSnapshot);
}

} // namespace

TEST(LoadFitSnapshotTest, CapturesEveryFitAffectingCommonParam) {
  common_params params;
  params.n_gpu_layers = 17;
  params.n_ctx = 4096;
  params.n_batch = 512;
  params.n_ubatch = 128;
  params.n_parallel = 3;
  params.split_mode = LLAMA_SPLIT_MODE_LAYER;
  params.main_gpu = 1;
  const size_t runtimeDeviceCount = llama_max_devices();
  ASSERT_LT(runtimeDeviceCount, std::size(params.tensor_split));
  std::vector<float> expectedTensorSplit;
  expectedTensorSplit.reserve(runtimeDeviceCount);
  for (size_t i = 0; i < runtimeDeviceCount; ++i) {
    const float value = static_cast<float>(i + 1) / 100.0F;
    params.tensor_split[i] = value;
    expectedTensorSplit.push_back(value);
  }
  params.cache_type_k = GGML_TYPE_Q8_0;
  params.cache_type_v = GGML_TYPE_Q4_0;
  params.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;
  // mlock without mmap: exercises both snapshot mappings at once
  // (useMmap = false, useMlock = true).
  params.load_mode = LLAMA_LOAD_MODE_MLOCK;
  params.no_kv_offload = true;
  params.no_op_offload = true;
  params.swa_full = true;
  params.kv_unified = true;
  params.no_extra_bufts = true;
  params.no_host = true;
  ggml_backend_buffer_type_t cpuBuft = ggml_backend_cpu_buffer_type();
  params.tensor_buft_overrides = {
      {"blk\\.0\\..*", cpuBuft}, {"output.*", cpuBuft}, {nullptr, nullptr}};

  const auto snapshot = lfn::makeNormalizedFitSnapshot(params, 8192);

  EXPECT_EQ(snapshot.nGpuLayers, 17);
  EXPECT_EQ(snapshot.nCtx, 4096U);
  EXPECT_EQ(snapshot.nBatch, 512U);
  EXPECT_EQ(snapshot.nUbatch, 128U);
  EXPECT_EQ(snapshot.nParallel, 3U);
  EXPECT_EQ(snapshot.splitMode, static_cast<int32_t>(LLAMA_SPLIT_MODE_LAYER));
  EXPECT_EQ(snapshot.mainGpu, 1);
  ASSERT_EQ(snapshot.tensorSplit.size(), runtimeDeviceCount);
  EXPECT_LT(snapshot.tensorSplit.size(), std::size(params.tensor_split));
  EXPECT_EQ(snapshot.tensorSplit, expectedTensorSplit);
  EXPECT_EQ(snapshot.typeK, static_cast<int32_t>(GGML_TYPE_Q8_0));
  EXPECT_EQ(snapshot.typeV, static_cast<int32_t>(GGML_TYPE_Q4_0));
  EXPECT_EQ(
      snapshot.flashAttnType,
      static_cast<int32_t>(LLAMA_FLASH_ATTN_TYPE_ENABLED));
  EXPECT_FALSE(snapshot.useMmap);
  EXPECT_TRUE(snapshot.useMlock);
  EXPECT_FALSE(snapshot.kvOffload);
  EXPECT_FALSE(snapshot.opOffload);
  EXPECT_TRUE(snapshot.swaFull);
  EXPECT_TRUE(snapshot.kvUnified);
  EXPECT_FALSE(snapshot.useExtraBufferTypes);
  EXPECT_FALSE(snapshot.useHostBuffer);
  ASSERT_EQ(snapshot.tensorBufferOverrides.size(), 2U);
  EXPECT_EQ(snapshot.tensorBufferOverrides[0].pattern, "blk\\.0\\..*");
  EXPECT_EQ(snapshot.tensorBufferOverrides[1].pattern, "output.*");
  EXPECT_EQ(
      snapshot.tensorBufferOverrides[0].bufferType,
      ggml_backend_buft_name(cpuBuft));
}

TEST(LoadFitSnapshotTest, MapsSwaFullOnlyToSwaFull) {
  expectOnlyMappedFieldChanges(
      &common_params::swa_full, &lfn::NormalizedFitSnapshot::swaFull);
}

TEST(LoadFitSnapshotTest, MapsKvUnifiedOnlyToKvUnified) {
  expectOnlyMappedFieldChanges(
      &common_params::kv_unified, &lfn::NormalizedFitSnapshot::kvUnified);
}

TEST(LoadFitSnapshotTest, MapsNoOpOffloadOnlyToInvertedOpOffload) {
  expectOnlyMappedFieldChanges(
      &common_params::no_op_offload, &lfn::NormalizedFitSnapshot::opOffload);
}

TEST(
    LoadFitSnapshotTest, MapsNoExtraBufferTypesOnlyToInvertedExtraBufferTypes) {
  expectOnlyMappedFieldChanges(
      &common_params::no_extra_bufts,
      &lfn::NormalizedFitSnapshot::useExtraBufferTypes);
}

TEST(LoadFitSnapshotTest, MapsNoHostOnlyToInvertedHostBuffer) {
  expectOnlyMappedFieldChanges(
      &common_params::no_host, &lfn::NormalizedFitSnapshot::useHostBuffer);
}

TEST(LoadFitSnapshotTest, CapturesFitPolicyDefaults) {
  common_params params;

  const auto snapshot = lfn::makeNormalizedFitSnapshot(params, 0);

  EXPECT_TRUE(snapshot.fitParams);
  EXPECT_EQ(snapshot.fitParamsMinCtx, 4096);
  EXPECT_EQ(
      snapshot.fitParamsTargetBytes,
      std::vector<uint64_t>(llama_max_devices(), 1024ULL * 1024ULL * 1024ULL));
}

TEST(LoadFitSnapshotTest, MapsFitParamsOnlyToFitParams) {
  expectOnlyMappedFieldChanges(
      &common_params::fit_params, &lfn::NormalizedFitSnapshot::fitParams);
}

TEST(LoadFitSnapshotTest, MapsFitParamsMinimumContextIndependently) {
  common_params baselineParams;
  const auto baselineSnapshot =
      lfn::makeNormalizedFitSnapshot(baselineParams, 0);
  common_params params;
  params.fit_params_min_ctx = 12'345;

  const auto snapshot = lfn::makeNormalizedFitSnapshot(params, 0);
  auto expectedSnapshot = baselineSnapshot;
  expectedSnapshot.fitParamsMinCtx = 12'345;

  EXPECT_EQ(snapshot, expectedSnapshot);
}

TEST(LoadFitSnapshotTest, OwnsEveryFitTargetMarginInOrder) {
  common_params baselineParams;
  const auto baselineSnapshot =
      lfn::makeNormalizedFitSnapshot(baselineParams, 0);
  common_params params;
  std::vector<uint64_t> expectedTargetBytes;
  expectedTargetBytes.reserve(params.fit_params_target.size());
  for (size_t i = 0; i < params.fit_params_target.size(); ++i) {
    const uint64_t value = 1'000'003ULL + i * 7'919ULL;
    params.fit_params_target[i] = static_cast<size_t>(value);
    expectedTargetBytes.push_back(value);
  }

  const auto snapshot = lfn::makeNormalizedFitSnapshot(params, 0);
  auto expectedSnapshot = baselineSnapshot;
  expectedSnapshot.fitParamsTargetBytes = expectedTargetBytes;

  EXPECT_EQ(snapshot, expectedSnapshot);
}

TEST(LoadFitSnapshotTest, CapturesEveryModelMetadataOverrideTypeInOrder) {
  common_params params;
  llama_model_kv_override intOverride{};
  intOverride.tag = LLAMA_KV_OVERRIDE_TYPE_INT;
  std::strcpy(intOverride.key, "metadata.int");
  intOverride.val_i64 = -9'876'543'210LL;
  llama_model_kv_override floatOverride{};
  floatOverride.tag = LLAMA_KV_OVERRIDE_TYPE_FLOAT;
  std::strcpy(floatOverride.key, "metadata.float");
  floatOverride.val_f64 = 1234.56789;
  llama_model_kv_override boolOverride{};
  boolOverride.tag = LLAMA_KV_OVERRIDE_TYPE_BOOL;
  std::strcpy(boolOverride.key, "metadata.bool");
  boolOverride.val_bool = true;
  llama_model_kv_override stringOverride{};
  stringOverride.tag = LLAMA_KV_OVERRIDE_TYPE_STR;
  std::strcpy(stringOverride.key, "metadata.string");
  std::strcpy(stringOverride.val_str, "distinctive-value");
  llama_model_kv_override terminator{};
  llama_model_kv_override afterTerminator{};
  afterTerminator.tag = LLAMA_KV_OVERRIDE_TYPE_INT;
  std::strcpy(afterTerminator.key, "metadata.after-terminator");
  afterTerminator.val_i64 = 42;
  params.kv_overrides = {
      intOverride,
      floatOverride,
      boolOverride,
      stringOverride,
      terminator,
      afterTerminator};

  const auto snapshot = lfn::makeNormalizedFitSnapshot(params, 0);

  ASSERT_EQ(snapshot.modelKvOverrides.size(), 4U);
  EXPECT_EQ(snapshot.modelKvOverrides[0].key, "metadata.int");
  EXPECT_EQ(
      snapshot.modelKvOverrides[0].type,
      static_cast<int32_t>(LLAMA_KV_OVERRIDE_TYPE_INT));
  EXPECT_EQ(
      std::get<int64_t>(snapshot.modelKvOverrides[0].value), -9'876'543'210LL);
  EXPECT_EQ(snapshot.modelKvOverrides[1].key, "metadata.float");
  EXPECT_EQ(
      snapshot.modelKvOverrides[1].type,
      static_cast<int32_t>(LLAMA_KV_OVERRIDE_TYPE_FLOAT));
  EXPECT_DOUBLE_EQ(
      std::get<double>(snapshot.modelKvOverrides[1].value), 1234.56789);
  EXPECT_EQ(snapshot.modelKvOverrides[2].key, "metadata.bool");
  EXPECT_EQ(
      snapshot.modelKvOverrides[2].type,
      static_cast<int32_t>(LLAMA_KV_OVERRIDE_TYPE_BOOL));
  EXPECT_TRUE(std::get<bool>(snapshot.modelKvOverrides[2].value));
  EXPECT_EQ(snapshot.modelKvOverrides[3].key, "metadata.string");
  EXPECT_EQ(
      snapshot.modelKvOverrides[3].type,
      static_cast<int32_t>(LLAMA_KV_OVERRIDE_TYPE_STR));
  EXPECT_EQ(
      std::get<std::string>(snapshot.modelKvOverrides[3].value),
      "distinctive-value");
}

TEST(LoadFitSnapshotTest, OwnsModelMetadataOverrideKeyAndStringValue) {
  lfn::NormalizedFitSnapshot snapshot;
  {
    common_params params;
    llama_model_kv_override stringOverride{};
    stringOverride.tag = LLAMA_KV_OVERRIDE_TYPE_STR;
    std::strcpy(stringOverride.key, "owned.metadata.key");
    std::strcpy(stringOverride.val_str, "owned metadata value");
    params.kv_overrides = {stringOverride, {}};

    snapshot = lfn::makeNormalizedFitSnapshot(params, 0);
    std::strcpy(params.kv_overrides[0].key, "mutated.metadata.key");
    std::strcpy(params.kv_overrides[0].val_str, "mutated metadata value");
  }

  ASSERT_EQ(snapshot.modelKvOverrides.size(), 1U);
  EXPECT_EQ(snapshot.modelKvOverrides[0].key, "owned.metadata.key");
  EXPECT_EQ(
      std::get<std::string>(snapshot.modelKvOverrides[0].value),
      "owned metadata value");
}

TEST(LoadFitSnapshotTest, RejectsUnknownModelMetadataOverrideType) {
  common_params params;
  llama_model_kv_override unknownOverride{};
  unknownOverride.tag = static_cast<llama_model_kv_override_type>(999);
  std::strcpy(unknownOverride.key, "metadata.unknown");
  params.kv_overrides = {unknownOverride, {}};

  EXPECT_THROW(
      static_cast<void>(lfn::makeNormalizedFitSnapshot(params, 0)),
      std::invalid_argument);
}

TEST(LoadFitSnapshotTest, NullBufferTypeIsEmptyAndTerminatorStopsCopying) {
  common_params params;
  ggml_backend_buffer_type_t cpuBuft = ggml_backend_cpu_buffer_type();
  params.tensor_buft_overrides = {
      {"null-buffer.*", nullptr},
      {nullptr, nullptr},
      {"after-terminator.*", cpuBuft},
  };

  const auto snapshot = lfn::makeNormalizedFitSnapshot(params, 0);

  ASSERT_EQ(snapshot.tensorBufferOverrides.size(), 1U);
  EXPECT_EQ(snapshot.tensorBufferOverrides[0].pattern, "null-buffer.*");
  EXPECT_TRUE(snapshot.tensorBufferOverrides[0].bufferType.empty());
}

TEST(LoadFitSnapshotTest, OwnsPatternAfterSourceMutationAndDestruction) {
  lfn::NormalizedFitSnapshot snapshot;
  {
    common_params params;
    std::string sourcePattern = "owned-pattern.*";
    params.tensor_buft_overrides = {
        {sourcePattern.c_str(), nullptr}, {nullptr, nullptr}};

    snapshot = lfn::makeNormalizedFitSnapshot(params, 0);
    sourcePattern.assign("mutated-pattern-with-different-storage.*");

    ASSERT_EQ(snapshot.tensorBufferOverrides.size(), 1U);
    EXPECT_EQ(snapshot.tensorBufferOverrides[0].pattern, "owned-pattern.*");
  }

  ASSERT_EQ(snapshot.tensorBufferOverrides.size(), 1U);
  EXPECT_EQ(snapshot.tensorBufferOverrides[0].pattern, "owned-pattern.*");
}

TEST(LoadFitSnapshotTest, ResolvesOnlyTheOmittedContextSentinel) {
  common_params omitted;
  omitted.n_ctx = 0;
  common_params explicitCtx;
  explicitCtx.n_ctx = 2048;

  EXPECT_EQ(lfn::makeNormalizedFitSnapshot(omitted, 8192).nCtx, 8192U);
  EXPECT_EQ(lfn::makeNormalizedFitSnapshot(omitted, 0).nCtx, 0U);
  EXPECT_EQ(lfn::makeNormalizedFitSnapshot(explicitCtx, 8192).nCtx, 2048U);
}

class LoadFitNormalizationTest : public ::testing::Test {
protected:
  test_common::MockModelMetaData metadata_{false, "llama"};

  static lfn::NormalizationDependencies
  backend(lfn::SelectedBackend selected, bool supportsRowSplit = false) {
    return {
        .resolveBackend =
            [selected](
                backend_selection::BackendType,
                const std::optional<backend_selection::MainGpu>&,
                const ModelMetaData&,
                bool,
                const std::vector<std::string>&) { return selected; },
        .gpuBackendSupportsRowSplit =
            [supportsRowSplit]() { return supportsRowSplit; }};
  }

  static lfn::ConfigMap baseConfig() {
    return {
        {"device", "gpu"},
        {"gpu-layers", "23"},
        {"batch-size", "512"},
        {"ubatch-size", "128"},
        {"parallel", "2"}};
  }
};

TEST_F(LoadFitNormalizationTest, ExplicitContextAndMinimumClampAreCanonical) {
  auto config = baseConfig();
  config["ctx-size"] = "4";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf",
      std::move(config),
      metadata_,
      {},
      backend({.type = backend_selection::GPU, .name = "none"}, true));
  EXPECT_EQ(result.params.n_ctx, 8);
  EXPECT_EQ(result.fitSnapshot.nCtx, 8U);
}

TEST_F(
    LoadFitNormalizationTest, MissingContextMetadataLeavesSnapshotUnresolved) {
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf",
      baseConfig(),
      metadata_,
      {},
      backend({.type = backend_selection::GPU, .name = "none"}, true));
  EXPECT_EQ(result.params.n_ctx, 0);
  EXPECT_EQ(result.fitSnapshot.nCtx, 0U);
}

TEST_F(LoadFitNormalizationTest, CpuFallbackClearsGpuPlacement) {
  auto config = baseConfig();
  config["split-mode"] = "layer";
  config["tensor-split"] = "0.25,0.75";
  config["main-gpu"] = "1";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf",
      std::move(config),
      metadata_,
      {},
      backend({.type = backend_selection::CPU, .name = "none"}));
  EXPECT_EQ(result.params.split_mode, LLAMA_SPLIT_MODE_NONE);
  EXPECT_EQ(result.params.main_gpu, -1);
  EXPECT_EQ(result.runtimeBackendDevice, 0);
}

TEST_F(LoadFitNormalizationTest, RowSplitDegradesOnlyWhenUnsupported) {
  auto config = baseConfig();
  config["split-mode"] = "row";
  const auto degraded = lfn::normalizeLoadForFit(
      "/tmp/model.gguf",
      config,
      metadata_,
      {},
      backend({.type = backend_selection::GPU, .name = "vulkan0"}, false));
  const auto retained = lfn::normalizeLoadForFit(
      "/tmp/model.gguf",
      std::move(config),
      metadata_,
      {},
      backend({.type = backend_selection::GPU, .name = "sycl0"}, true));
  EXPECT_EQ(degraded.params.split_mode, LLAMA_SPLIT_MODE_LAYER);
  EXPECT_EQ(retained.params.split_mode, LLAMA_SPLIT_MODE_ROW);
}

TEST_F(LoadFitNormalizationTest, RowSplitProbeRunsOnlyForSelectedGpuRowMode) {
  int probeCalls = 0;
  auto dependencies = backend({.type = backend_selection::CPU, .name = "none"});
  dependencies.gpuBackendSupportsRowSplit = [&probeCalls]() {
    ++probeCalls;
    return false;
  };

  auto cpuRowConfig = baseConfig();
  cpuRowConfig["split-mode"] = "row";
  static_cast<void>(lfn::normalizeLoadForFit(
      "/tmp/model.gguf", std::move(cpuRowConfig), metadata_, {}, dependencies));
  EXPECT_EQ(probeCalls, 0);

  dependencies.resolveBackend =
      [](backend_selection::BackendType,
         const std::optional<backend_selection::MainGpu>&,
         const ModelMetaData&,
         bool,
         const std::vector<std::string>&) {
        return lfn::SelectedBackend{
            .type = backend_selection::GPU, .name = "none"};
      };
  static_cast<void>(lfn::normalizeLoadForFit(
      "/tmp/model.gguf", baseConfig(), metadata_, {}, dependencies));
  EXPECT_EQ(probeCalls, 0);

  auto gpuRowConfig = baseConfig();
  gpuRowConfig["split-mode"] = "row";
  static_cast<void>(lfn::normalizeLoadForFit(
      "/tmp/model.gguf", std::move(gpuRowConfig), metadata_, {}, dependencies));
  EXPECT_EQ(probeCalls, 1);
}

// QVAC-23763: the split-mode --device branch. A CPU-only test process has no
// real GPU device to name, so these lean on qvac-fabric's own
// parse_device_list: the whole value "none" is legal and yields a one-entry
// devices list, while any multi-entry value is looked up per name and throws.
// That is enough to pin down whether the flag was emitted at all and whether
// the comma join happened.
TEST_F(LoadFitNormalizationTest, SplitModeOmitsDeviceWhenTheDependencyIsUnset) {
  auto config = baseConfig();
  config["split-mode"] = "layer";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf",
      std::move(config),
      metadata_,
      {},
      backend({.type = backend_selection::GPU, .name = "none"}));
  EXPECT_TRUE(result.params.devices.empty());
}

TEST_F(LoadFitNormalizationTest, SplitModeOmitsDeviceOnAnEmptyDeviceList) {
  auto dependencies = backend({.type = backend_selection::GPU, .name = "none"});
  dependencies.splitModeDeviceNames = [](const std::string&) {
    return std::vector<std::string>{};
  };
  auto config = baseConfig();
  config["split-mode"] = "layer";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf", std::move(config), metadata_, {}, dependencies);
  EXPECT_TRUE(result.params.devices.empty());
}

TEST_F(LoadFitNormalizationTest, SplitModeEmitsDeviceForTheScopedList) {
  auto dependencies = backend({.type = backend_selection::GPU, .name = "none"});
  std::string seenSelectedName;
  dependencies.splitModeDeviceNames =
      [&seenSelectedName](const std::string& selectedName) {
        seenSelectedName = selectedName;
        return std::vector<std::string>{"none"};
      };
  auto config = baseConfig();
  config["split-mode"] = "layer";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf", std::move(config), metadata_, {}, dependencies);
  EXPECT_EQ(seenSelectedName, "none");
  EXPECT_FALSE(result.params.devices.empty());
}

// A two-name list must reach the parser as one comma-joined value. If the join
// were dropped and only the first name emitted, the value would be the legal
// "none" and this would not throw.
TEST_F(LoadFitNormalizationTest, SplitModeJoinsSeveralDevicesIntoOneValue) {
  auto dependencies = backend({.type = backend_selection::GPU, .name = "none"});
  dependencies.splitModeDeviceNames = [](const std::string&) {
    return std::vector<std::string>{"none", "phantom0"};
  };
  auto config = baseConfig();
  config["split-mode"] = "layer";
  EXPECT_THROW(
      static_cast<void>(lfn::normalizeLoadForFit(
          "/tmp/model.gguf", std::move(config), metadata_, {}, dependencies)),
      qvac_errors::StatusError);
}

// QVAC-23763: --main-gpu indexes the list llama.cpp is handed. Once --device is
// scoped, the caller's index is resolved against a longer list and must be
// rewritten to the selected device's position rather than forwarded as-is.
TEST_F(LoadFitNormalizationTest, SplitModeRewritesMainGpuToTheScopedPosition) {
  auto dependencies = backend({.type = backend_selection::GPU, .name = "none"});
  dependencies.splitModeDeviceNames = [](const std::string&) {
    return std::vector<std::string>{"none"};
  };
  auto config = baseConfig();
  config["split-mode"] = "layer";
  config["main-gpu"] = "3";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf", std::move(config), metadata_, {}, dependencies);
  EXPECT_EQ(result.params.main_gpu, 0);
}

// A single-registry host omits --device, so llama.cpp still sees every device
// and the caller's index must survive untouched.
TEST_F(LoadFitNormalizationTest, SplitModeKeepsMainGpuWhenDeviceIsOmitted) {
  auto dependencies = backend({.type = backend_selection::GPU, .name = "none"});
  dependencies.splitModeDeviceNames = [](const std::string&) {
    return std::vector<std::string>{};
  };
  auto config = baseConfig();
  config["split-mode"] = "layer";
  config["main-gpu"] = "3";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf", std::move(config), metadata_, {}, dependencies);
  EXPECT_EQ(result.params.main_gpu, 3);
}

// Single-GPU mode keeps pinning to the selected device and must not consult the
// split-mode list at all.
TEST_F(LoadFitNormalizationTest, SingleGpuModeIgnoresTheSplitDeviceList) {
  bool consulted = false;
  auto dependencies = backend({.type = backend_selection::GPU, .name = "none"});
  dependencies.splitModeDeviceNames = [&consulted](const std::string&) {
    consulted = true;
    return std::vector<std::string>{"phantom0"};
  };
  auto config = baseConfig();
  config["split-mode"] = "none";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf", std::move(config), metadata_, {}, dependencies);
  EXPECT_FALSE(consulted);
  EXPECT_FALSE(result.params.devices.empty());
}

TEST_F(
    LoadFitNormalizationTest, GpuDefaultsReachCanonicalKvAndPlacementFields) {
  auto config = baseConfig();
  config["ctx-size"] = "4096";
  config["split-mode"] = "layer";
  config["main-gpu"] = "1";
  config["tensor-split"] = "0.25,0.75";
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf",
      std::move(config),
      metadata_,
      {},
      backend({.type = backend_selection::GPU, .name = "vulkan0"}, true));
  EXPECT_EQ(result.runtimeBackendDevice, 1);
  EXPECT_EQ(result.fitSnapshot.nGpuLayers, 23);
  EXPECT_EQ(result.fitSnapshot.nCtx, 4096U);
  EXPECT_EQ(result.fitSnapshot.nBatch, 512U);
  EXPECT_EQ(result.fitSnapshot.nUbatch, 128U);
  EXPECT_EQ(result.fitSnapshot.nParallel, 2U);
  EXPECT_EQ(result.fitSnapshot.splitMode, LLAMA_SPLIT_MODE_LAYER);
  EXPECT_EQ(result.fitSnapshot.mainGpu, 1);
  EXPECT_EQ(result.fitSnapshot.tensorSplit[0], 0.25F);
  EXPECT_EQ(result.fitSnapshot.tensorSplit[1], 0.75F);
  EXPECT_EQ(result.fitSnapshot.typeK, static_cast<int32_t>(GGML_TYPE_Q8_0));
  EXPECT_EQ(result.fitSnapshot.typeV, static_cast<int32_t>(GGML_TYPE_Q8_0));
}

TEST_F(LoadFitNormalizationTest, FinetuneOutputsRemainExplicit) {
  auto config = baseConfig();
  const auto result = lfn::normalizeLoadForFit(
      "/tmp/model.gguf",
      std::move(config),
      metadata_,
      {.active = true,
       .batchSize = 64,
       .microBatchSize = 16,
       .contextLength = 256,
       .flashAttn = false},
      backend({.type = backend_selection::CPU, .name = "none"}));
  EXPECT_TRUE(result.params.training);
  EXPECT_EQ(result.params.n_ctx, 256);
  EXPECT_EQ(result.params.n_batch, 64);
  EXPECT_EQ(result.params.n_ubatch, 16);
}

TEST_F(LoadFitNormalizationTest, MissingDeviceKeepsLegacyErrorMapping) {
  auto config = baseConfig();
  config.erase("device");
  try {
    static_cast<void>(lfn::normalizeLoadForFit(
        "/tmp/model.gguf",
        std::move(config),
        metadata_,
        {},
        backend({.type = backend_selection::CPU, .name = "none"})));
    FAIL() << "missing device must throw";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_THAT(error.what(), ::testing::HasSubstr("commonParamsParse"));
    EXPECT_THAT(error.what(), ::testing::HasSubstr("must specify a device"));
  }
}

TEST_F(LoadFitNormalizationTest, RetiredDiscardKeyIsRejectedAsUnknownArgument) {
  auto config = baseConfig();
  config["n_discarded"] = "64";
  try {
    static_cast<void>(lfn::normalizeLoadForFit(
        "/tmp/model.gguf",
        std::move(config),
        metadata_,
        {},
        backend({.type = backend_selection::CPU, .name = "none"})));
    FAIL() << "retired n_discarded key must throw";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_THAT(error.what(), ::testing::HasSubstr("commonParamsParse"));
    EXPECT_THAT(error.what(), ::testing::HasSubstr("invalid argument"));
    EXPECT_THAT(error.what(), ::testing::HasSubstr("n-discarded"));
  }
}

TEST_F(LoadFitNormalizationTest, DuplicateSplitModeRemainsInvalidArgument) {
  auto config = baseConfig();
  config["split-mode"] = "layer";
  config["split_mode"] = "layer";
  EXPECT_THROW(
      static_cast<void>(lfn::normalizeLoadForFit(
          "/tmp/model.gguf",
          std::move(config),
          metadata_,
          {},
          backend({.type = backend_selection::CPU, .name = "none"}))),
      qvac_errors::StatusError);
}

TEST_F(LoadFitNormalizationTest, UnknownGenericArgumentRemainsInvalid) {
  auto config = baseConfig();
  config["invalid_arg_name_xyz"] = "value";
  EXPECT_THROW(
      static_cast<void>(lfn::normalizeLoadForFit(
          "/tmp/model.gguf",
          std::move(config),
          metadata_,
          {},
          backend({.type = backend_selection::CPU, .name = "none"}))),
      qvac_errors::StatusError);
}

TEST_F(LoadFitNormalizationTest, InvalidChatTemplateRemainsInvalid) {
  auto config = baseConfig();
  config["chat-template"] = "invalid_template_name_xyz123";
  EXPECT_THROW(
      static_cast<void>(lfn::normalizeLoadForFit(
          "/tmp/model.gguf",
          std::move(config),
          metadata_,
          {},
          backend({.type = backend_selection::CPU, .name = "none"}))),
      qvac_errors::StatusError);
}

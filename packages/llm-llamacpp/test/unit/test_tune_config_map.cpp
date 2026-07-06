#include <optional>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

using test_common::MockModelMetaData;
using FtOverrides = FinetuneConfigOverrides;

class TuneConfigMapTest : public ::testing::Test {
protected:
  std::unordered_map<std::string, std::string> configFilemap_;
};

TEST_F(TuneConfigMapTest, NonBitnet_FlashAttnDefaultsOn) {
  MockModelMetaData meta(false, "llama");

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

TEST_F(TuneConfigMapTest, OneBitButNotBitnetArch_FlashAttnDefaultsOn) {
  MockModelMetaData meta(true, "llama");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

TEST_F(TuneConfigMapTest, BitnetArchButNotOneBit_FlashAttnDefaultsOn) {
  MockModelMetaData meta(false, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- BitNet without Adreno: flash-attn disabled, ubatch unchanged ----

TEST_F(TuneConfigMapTest, Bitnet_NoAdreno_FlashAttnDisabled) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Bitnet_NoAdreno_UbatchUnchanged) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt);

  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- BitNet with Adreno <800: flash-attn disabled, ubatch unchanged ----

TEST_F(TuneConfigMapTest, Bitnet_Adreno740_FlashAttnDisabled) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 740);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno740_UbatchUnchanged) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 740);

  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- BitNet with Adreno 800+: flash-attn disabled AND ubatch=128 ----

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_FlashAttnDisabled) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UbatchSetTo128) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno800_UbatchSetTo128) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 800);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- User overrides are respected ----

TEST_F(TuneConfigMapTest, Bitnet_UserSetFlashAttnHyphen_Respected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["flash-attn"] = "on";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

TEST_F(TuneConfigMapTest, Bitnet_UserSetFlashAttnUnderscore_Respected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["flash_attn"] = "on";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_.count("flash-attn"), 0);
  EXPECT_EQ(configFilemap_["flash_attn"], "on");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchHyphen_ClampedTo128) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch-size"] = "256";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchHyphen_SmallRespected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch-size"] = "64";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "64");
}

TEST_F(
    TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchUnderscore_ClampedTo128) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch_size"] = "256";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
  EXPECT_EQ(configFilemap_.count("ubatch_size"), 0);
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchUnderscore_Respected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch_size"] = "64";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "64");
  EXPECT_EQ(configFilemap_.count("ubatch_size"), 0);
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_InvalidUbatch_FallsBackToDefault) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch-size"] = "auto";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- Edge: Adreno 799 (just below threshold) ----

TEST_F(TuneConfigMapTest, Bitnet_Adreno799_UbatchUnchanged) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 799);

  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- OpenCL backend: flash-attn defaulted ON like every other GPU path ----

TEST_F(TuneConfigMapTest, OpenCl_NonBitnet_FlashAttnDefaultsOn) {
  MockModelMetaData meta(false, "llama");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

TEST_F(TuneConfigMapTest, OpenCl_UserSetFlashAttnHyphen_Respected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "on";

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true);

  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

TEST_F(TuneConfigMapTest, OpenCl_UserSetFlashAttnUnderscore_Respected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash_attn"] = "on";

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true);

  EXPECT_EQ(configFilemap_.count("flash-attn"), 0);
  EXPECT_EQ(configFilemap_["flash_attn"], "on");
}

TEST_F(TuneConfigMapTest, NotOpenCl_NonBitnet_FlashAttnDefaultsOn) {
  MockModelMetaData meta(false, "llama");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/false);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

// ---- OpenCL rejects ALL quantized KV types; only f32/f16/bf16 are safe ----

TEST_F(TuneConfigMapTest, OpenCl_RejectsQ8_0KCache) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";

  // QVAC-21318: quantized KV on OpenCL is rejected — q8_0 K aborts in
  // llama_kv_cache::update on a KV-cache shift on Adreno (no ggml-opencl
  // F32->quantized requantize kernel).
  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, OpenCl_RejectsQ4_0VCacheUnderscore) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache_type_v"] = "q4_0";

  // QVAC-21318: q4_0 hits the same shift crash as q8_0 on Adreno OpenCL
  // (CI-confirmed, run 28448086915) — rejected too.
  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, OpenCl_RejectsUnsupportedQuantizedKCache) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q5_0";

  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, OpenCl_RejectsUnsupportedQuantizedVCacheUnderscore) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache_type_v"] = "iq4_nl";

  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, OpenCl_RejectsTurboQuantKCache) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "tbq4_0";

  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

// Reject-by-default: a type outside the known-safe OpenCL set
// {f32,f16,bf16} must fail cleanly rather than fall through.
TEST_F(TuneConfigMapTest, OpenCl_RejectsUnlistedKvType) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q6_K";

  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, OpenCl_AllowsNonQuantizedCacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "f16";
  configFilemap_["cache-type-v"] = "bf16";

  EXPECT_NO_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/true));
}

TEST_F(TuneConfigMapTest, NotOpenCl_AllowsStandardQuantizedCacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["cache-type-v"] = "q4_0";

  EXPECT_NO_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false));
}

TEST_F(TuneConfigMapTest, NotOpenClNotMetal_AllowsTurboQuantCacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "tbq4_0";
  configFilemap_["cache-type-v"] = "pq4_0";

  EXPECT_NO_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false));
}

TEST_F(TuneConfigMapTest, Metal_RejectsTurboQuantCacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "tbq4_0";

  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, Metal_AllowsStandardQuantizedCacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["cache-type-v"] = "q4_0";

  EXPECT_NO_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/true));
}

// ---- Finetuning: flash-attn disabled for any architecture ----

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_FlashAttnDisabled) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Finetuning_UserSetFlashAttn_ForcedOff) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["flash-attn"] = "on";

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Finetuning_UserSetFlashAttnUnderscore_ForcedOff) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["flash_attn"] = "on";

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["flash-attn"], "off");
  EXPECT_EQ(configFilemap_.count("flash_attn"), 0);
}

TEST_F(TuneConfigMapTest, Finetuning_FlashAttnExplicitlyEnabled_ForcedOn) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["flash-attn"] = "off";

  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{.active = true, .flashAttn = true});

  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

// ---- Finetuning on Adreno 800+: ubatch=128 regardless of arch ----

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_Adreno830_UbatchSetTo128) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, 830, FtOverrides{.active = true});

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_Adreno800_UbatchSetTo128) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, 800, FtOverrides{.active = true});

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_Qwen3_Adreno830_UbatchSetTo128) {
  MockModelMetaData meta(false, "qwen3");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, 830, FtOverrides{.active = true});

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- Finetuning on Adreno <800: ubatch from finetune overrides ----

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_Adreno740_UbatchFromOverrides) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, 740, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_Adreno799_UbatchFromOverrides) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, 799, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- Finetuning without Adreno: ubatch from overrides ----

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_NoAdreno_UbatchFromOverrides) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- Finetuning overrides user inference config ----

TEST_F(TuneConfigMapTest, Finetuning_Adreno830_OverridesUserUbatchHyphen) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["ubatch-size"] = "256";

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, 830, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_Adreno830_OverridesUserUbatchUnderscore) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["ubatch_size"] = "64";

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, 830, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
  EXPECT_EQ(configFilemap_.count("ubatch_size"), 0);
}

// ---- Finetuning context/batch param injection ----

TEST_F(TuneConfigMapTest, Finetuning_ContextLengthInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .contextLength = 256};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("ctx-size"), 1);
  EXPECT_EQ(configFilemap_["ctx-size"], "256");
}

TEST_F(TuneConfigMapTest, Finetuning_BatchSizeInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .batchSize = 64};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("batch-size"), 1);
  EXPECT_EQ(configFilemap_["batch-size"], "64");
}

TEST_F(TuneConfigMapTest, Finetuning_MicroBatchSizeInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .microBatchSize = 16};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "16");
}

TEST_F(TuneConfigMapTest, Finetuning_AllParamsInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{
      .active = true,
      .batchSize = 64,
      .microBatchSize = 16,
      .contextLength = 256};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["ctx-size"], "256");
  EXPECT_EQ(configFilemap_["batch-size"], "64");
  EXPECT_EQ(configFilemap_["ubatch-size"], "16");
}

TEST_F(TuneConfigMapTest, Finetuning_DefaultParamsInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["ctx-size"], "128");
  EXPECT_EQ(configFilemap_["batch-size"], "128");
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_OverridesUserCtxSizeHyphen) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["ctx-size"] = "512";
  FtOverrides ov{.active = true, .contextLength = 256};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["ctx-size"], "256");
}

TEST_F(TuneConfigMapTest, Finetuning_OverridesUserCtxSizeUnderscore) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["ctx_size"] = "512";
  FtOverrides ov{.active = true, .contextLength = 256};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["ctx-size"], "256");
  EXPECT_EQ(configFilemap_.count("ctx_size"), 0);
}

TEST_F(TuneConfigMapTest, Finetuning_OverridesUserBatchSizeHyphen) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["batch-size"] = "128";
  FtOverrides ov{.active = true, .batchSize = 64};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["batch-size"], "64");
}

TEST_F(TuneConfigMapTest, Finetuning_OverridesUserBatchSizeUnderscore) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["batch_size"] = "128";
  FtOverrides ov{.active = true, .batchSize = 64};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["batch-size"], "64");
  EXPECT_EQ(configFilemap_.count("batch_size"), 0);
}

// Finetuning microBatchSize takes precedence over Adreno 800+ default
TEST_F(TuneConfigMapTest, Finetuning_MicroBatchOverridesAdrenoDefault) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .microBatchSize = 32};

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830, ov);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "32");
}

// Default microBatchSize (128) applies regardless of Adreno version
TEST_F(TuneConfigMapTest, Finetuning_DefaultMicroBatch_Adreno830) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true};

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830, ov);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// Not finetuning (nullopt): no overrides applied
TEST_F(TuneConfigMapTest, NotFinetuning_NoOverridesApplied) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt);

  EXPECT_EQ(configFilemap_.count("ctx-size"), 0);
  EXPECT_EQ(configFilemap_.count("batch-size"), 0);
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- Finetuning KV cache quantization ----

TEST_F(TuneConfigMapTest, Finetuning_NoF16OutProd_CacheTypesSetToF32) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = false};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("cache-type-k"), 1);
  EXPECT_EQ(configFilemap_["cache-type-k"], "f32");
  ASSERT_EQ(configFilemap_.count("cache-type-v"), 1);
  EXPECT_EQ(configFilemap_["cache-type-v"], "f32");
}

TEST_F(TuneConfigMapTest, Finetuning_SupportsF16OutProd_CacheTypesUnchanged) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = true};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, Finetuning_DefaultOverrides_CacheTypesUnchanged) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, Finetuning_NoF16_UserSetCacheTypeK_Respected) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["cache-type-k"] = "q8_0";
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = false};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["cache-type-k"], "q8_0");
  ASSERT_EQ(configFilemap_.count("cache-type-v"), 1);
  EXPECT_EQ(configFilemap_["cache-type-v"], "f32");
}

TEST_F(TuneConfigMapTest, Finetuning_NoF16_UserSetCacheTypeV_Respected) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["cache-type-v"] = "q8_0";
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = false};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("cache-type-k"), 1);
  EXPECT_EQ(configFilemap_["cache-type-k"], "f32");
  EXPECT_EQ(configFilemap_["cache-type-v"], "q8_0");
}

TEST_F(
    TuneConfigMapTest, Finetuning_NoF16_UserSetCacheTypeKUnderscore_Respected) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["cache_type_k"] = "q8_0";
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = false};

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_["cache_type_k"], "q8_0");
}

TEST_F(TuneConfigMapTest, NotFinetuning_CacheTypesUnchanged) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

// ---- Tier 1: Adreno 800+ Vulkan rejects quantized KV with flash attention
// ----

TEST_F(TuneConfigMapTest, AdrenoVulkan_QuantizedKCache_FlashAttnOn_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  // Set flash-attn explicitly so the test does not depend on the FA-default
  // ordering elsewhere in tuneConfigMap().
  configFilemap_["flash-attn"] = "on";

  // isOpenCl=false, isMetal=false, isGpu=true, adreno=830 -> Vulkan on Adreno.
  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true),
      qvac_errors::StatusError);
}

TEST_F(
    TuneConfigMapTest,
    AdrenoVulkan_QuantizedKCacheUnderscore_FlashAttnOn_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache_type_k"] = "q8_0";
  configFilemap_["flash-attn"] = "on";

  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true),
      qvac_errors::StatusError);
}

// An underscore flash_attn=on must still arm the Adreno-Vulkan reject guard
// (flashAttnOn is read from both key variants).
TEST_F(
    TuneConfigMapTest,
    AdrenoVulkan_QuantizedKCache_FlashAttnUnderscore_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash_attn"] = "on";

  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true),
      qvac_errors::StatusError);
}

// The Adreno-Vulkan guard requires isGpu: a non-GPU call (even with an Adreno
// version + quantized KV) must NOT fire it.
TEST_F(TuneConfigMapTest, AdrenoVulkan_QuantizedKCache_NotGpu_Allowed) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash-attn"] = "on";

  EXPECT_NO_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/false));
}

TEST_F(TuneConfigMapTest, AdrenoVulkan_QuantizedVCache_FlashAttnOff_Allowed) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-v"] = "q8_0";
  configFilemap_["flash-attn"] = "off";

  EXPECT_NO_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true));
}

TEST_F(TuneConfigMapTest, AdrenoOpenCl_QuantizedKCache_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";

  // QVAC-21318: quantized KV on Adreno OpenCL is rejected — the KV-cache shift
  // requantize copy has no ggml-opencl kernel and aborts in
  // llama_kv_cache::update (true for q8_0 and q4_0).
  EXPECT_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/true,
          /*isMetal=*/false,
          /*isGpu=*/true),
      qvac_errors::StatusError);
}

// QVAC-21318: mixed/asymmetric K!=V with a quantized side is a WARNING, not an
// error — the call still succeeds (callers may opt in). Non-OpenCL so the
// OpenCL guard doesn't fire first.
TEST_F(TuneConfigMapTest, MixedQuantizedAsymmetric_WarnsButAllowed) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["cache-type-v"] = "q4_0";

  EXPECT_NO_THROW(
      LlamaModel::tuneConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true));
}

// ---- Auto-default q8_0 KV on GPU backends (QVAC-21318) ----

TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_DefaultsQ8_0) {
  MockModelMetaData meta(false, "llama");
  // Set flash-attn explicitly (the q8_0 auto-default requires it) so the test
  // doesn't rely on the earlier default-FA block's ordering.
  configFilemap_["flash-attn"] = "on";

  // Plain (non-Adreno) GPU: isGpu=true, not OpenCL/Metal, no adreno version.
  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/true);

  ASSERT_EQ(configFilemap_.count("cache-type-k"), 1);
  EXPECT_EQ(configFilemap_["cache-type-k"], "q8_0");
  ASSERT_EQ(configFilemap_.count("cache-type-v"), 1);
  EXPECT_EQ(configFilemap_["cache-type-v"], "q8_0");
}

// Underscore flash_attn variant must also arm the q8_0 auto-default.
TEST_F(
    TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnUnderscore_DefaultsQ8_0) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash_attn"] = "on";

  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/true);

  EXPECT_EQ(configFilemap_["cache-type-k"], "q8_0");
  EXPECT_EQ(configFilemap_["cache-type-v"], "q8_0");
}

TEST_F(TuneConfigMapTest, AutoDefault_OpenClGpu_StaysF16) {
  MockModelMetaData meta(false, "llama");

  // OpenCL is excluded from the q8_0 auto-default: quantized KV-cache shifts
  // abort on Adreno, so f16 stays the default (an explicit quantized type is
  // rejected too — see OpenCl_RejectsQ8_0KCache).
  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/true,
      /*isMetal=*/false,
      /*isGpu=*/true);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_MetalGpu_DefaultsQ8_0) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "on";

  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/true,
      /*isGpu=*/true);

  EXPECT_EQ(configFilemap_["cache-type-k"], "q8_0");
  EXPECT_EQ(configFilemap_["cache-type-v"], "q8_0");
}

TEST_F(TuneConfigMapTest, AutoDefault_Cpu_StaysF16) {
  MockModelMetaData meta(false, "llama");

  // isGpu=false (CPU) -> no auto-default; KV types left to llama.cpp (f16).
  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/false);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_UserSetKCache_NotOverridden) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "f16";

  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/true);

  // User set K -> the default does not apply to either side.
  EXPECT_EQ(configFilemap_["cache-type-k"], "f16");
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_UserSetVCache_KNotDefaulted) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-v"] = "f16";

  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/true);

  // User set V -> the all-or-nothing default does not independently set K.
  EXPECT_EQ(configFilemap_["cache-type-v"], "f16");
  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_FlashAttnOff_NotApplied) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "off";

  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/true);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_Finetuning_NotApplied) {
  MockModelMetaData meta(false, "gemma3");

  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{.active = true},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/true);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_AdrenoVulkan_NotApplied) {
  MockModelMetaData meta(false, "llama");

  // Defensive: Adreno 800+ on Vulkan must not be auto-defaulted to quant KV
  // (no fabric scalar-FA fix on this branch).
  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      830,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/true);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_AdrenoOpenCl_StaysF16) {
  MockModelMetaData meta(false, "llama");

  // Adreno (OpenCL) keeps the f16 default — quantized KV-cache shifts abort
  // there, and an explicit quantized type is rejected as well (see
  // AdrenoOpenCl_QuantizedKCache_Rejected).
  LlamaModel::tuneConfigMap(
      configFilemap_,
      meta,
      830,
      FtOverrides{},
      /*isOpenCl=*/true,
      /*isMetal=*/false,
      /*isGpu=*/true);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

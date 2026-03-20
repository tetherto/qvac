#include <optional>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

using test_common::MockModelMetaData;
using FtOverrides = FinetuneConfigOverrides;

class TuneConfigMapTest : public ::testing::Test {
protected:
  std::unordered_map<std::string, std::string> configFilemap_;
};

// ---- Non-BitNet: no modifications ----

TEST_F(TuneConfigMapTest, NonBitnet_NoChanges) {
  MockModelMetaData meta(false, "llama");

  LlamaModel::tuneConfigMap(configFilemap_, meta, std::nullopt);

  EXPECT_EQ(configFilemap_.count("flash-attn"), 0);
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

TEST_F(TuneConfigMapTest, OneBitButNotBitnetArch_NoChanges) {
  MockModelMetaData meta(true, "llama");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_.count("flash-attn"), 0);
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

TEST_F(TuneConfigMapTest, BitnetArchButNotOneBit_NoChanges) {
  MockModelMetaData meta(false, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_.count("flash-attn"), 0);
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

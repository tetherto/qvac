#include <optional>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/LoadFitNormalization.hpp"
#include "test_common.hpp"

using test_common::MockModelMetaData;
using FtOverrides = FinetuneConfigOverrides;

class TuneConfigMapTest : public ::testing::Test {
protected:
  std::unordered_map<std::string, std::string> configFilemap_;
};

TEST_F(TuneConfigMapTest, NonBitnet_FlashAttnDefaultsOn) {
  MockModelMetaData meta(false, "llama");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, std::nullopt);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

TEST_F(TuneConfigMapTest, OneBitButNotBitnetArch_FlashAttnDefaultsOn) {
  MockModelMetaData meta(true, "llama");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

TEST_F(TuneConfigMapTest, BitnetArchButNotOneBit_FlashAttnDefaultsOn) {
  MockModelMetaData meta(false, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- BitNet without Adreno: flash-attn disabled, ubatch unchanged ----

TEST_F(TuneConfigMapTest, Bitnet_NoAdreno_FlashAttnDisabled) {
  MockModelMetaData meta(true, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, std::nullopt);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Bitnet_NoAdreno_UbatchUnchanged) {
  MockModelMetaData meta(true, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, std::nullopt);

  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- BitNet with Adreno <800: flash-attn disabled, ubatch unchanged ----

TEST_F(TuneConfigMapTest, Bitnet_Adreno740_FlashAttnDisabled) {
  MockModelMetaData meta(true, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 740);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno740_UbatchUnchanged) {
  MockModelMetaData meta(true, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 740);

  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- BitNet with Adreno 800+: flash-attn disabled AND ubatch=128 ----

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_FlashAttnDisabled) {
  MockModelMetaData meta(true, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UbatchSetTo128) {
  MockModelMetaData meta(true, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno800_UbatchSetTo128) {
  MockModelMetaData meta(true, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 800);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- User overrides are respected ----

TEST_F(TuneConfigMapTest, Bitnet_UserSetFlashAttnHyphen_Respected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["flash-attn"] = "on";

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

TEST_F(TuneConfigMapTest, Bitnet_UserSetFlashAttnUnderscore_Respected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["flash_attn"] = "on";

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_.count("flash-attn"), 0);
  EXPECT_EQ(configFilemap_["flash_attn"], "on");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchHyphen_ClampedTo128) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch-size"] = "256";

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchHyphen_SmallRespected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch-size"] = "64";

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "64");
}

TEST_F(
    TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchUnderscore_ClampedTo128) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch_size"] = "256";

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
  EXPECT_EQ(configFilemap_.count("ubatch_size"), 0);
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchUnderscore_Respected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch_size"] = "64";

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "64");
  EXPECT_EQ(configFilemap_.count("ubatch_size"), 0);
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_InvalidUbatch_FallsBackToDefault) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch-size"] = "auto";

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- Edge: Adreno 799 (just below threshold) ----

TEST_F(TuneConfigMapTest, Bitnet_Adreno799_UbatchUnchanged) {
  MockModelMetaData meta(true, "bitnet");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 799);

  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- OpenCL backend: flash-attn defaulted ON like every other GPU path ----

TEST_F(TuneConfigMapTest, OpenCl_NonBitnet_FlashAttnDefaultsOn) {
  MockModelMetaData meta(false, "llama");

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true);

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

TEST_F(TuneConfigMapTest, OpenCl_UserSetFlashAttnHyphen_Respected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "on";

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true);

  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

TEST_F(TuneConfigMapTest, OpenCl_UserSetFlashAttnUnderscore_Respected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash_attn"] = "on";

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true);

  EXPECT_EQ(configFilemap_.count("flash-attn"), 0);
  EXPECT_EQ(configFilemap_["flash_attn"], "on");
}

TEST_F(TuneConfigMapTest, NotOpenCl_NonBitnet_FlashAttnDefaultsOn) {
  MockModelMetaData meta(false, "llama");

  load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, OpenCl_RejectsUnsupportedQuantizedVCacheUnderscore) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache_type_v"] = "iq4_nl";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, OpenCl_RejectsTurboQuantKCache) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "tbq4_0";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

// Reject-by-default: a type outside the known-safe OpenCL set
// {f32,f16,bf16} must fail cleanly rather than fall through.
TEST_F(TuneConfigMapTest, OpenCl_RejectsUnlistedKvType) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q6_K";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_, meta, std::nullopt, FtOverrides{}, /*isOpenCl=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, OpenCl_AllowsNonQuantizedCacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "f16";
  configFilemap_["cache-type-v"] = "bf16";

  EXPECT_NO_THROW(
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  ASSERT_EQ(configFilemap_.count("flash-attn"), 1);
  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Finetuning_UserSetFlashAttn_ForcedOff) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["flash-attn"] = "on";

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["flash-attn"], "off");
}

TEST_F(TuneConfigMapTest, Finetuning_UserSetFlashAttnUnderscore_ForcedOff) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["flash_attn"] = "on";

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["flash-attn"], "off");
  EXPECT_EQ(configFilemap_.count("flash_attn"), 0);
}

TEST_F(TuneConfigMapTest, Finetuning_FlashAttnExplicitlyEnabled_ForcedOn) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["flash-attn"] = "off";

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{.active = true, .flashAttn = true});

  EXPECT_EQ(configFilemap_["flash-attn"], "on");
}

// ---- Finetuning on Adreno 800+: ubatch=128 regardless of arch ----

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_Adreno830_UbatchSetTo128) {
  MockModelMetaData meta(false, "gemma3");

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, 830, FtOverrides{.active = true});

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_Adreno800_UbatchSetTo128) {
  MockModelMetaData meta(false, "gemma3");

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, 800, FtOverrides{.active = true});

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_Qwen3_Adreno830_UbatchSetTo128) {
  MockModelMetaData meta(false, "qwen3");

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, 830, FtOverrides{.active = true});

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- Finetuning on Adreno <800: ubatch from finetune overrides ----

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_Adreno740_UbatchFromOverrides) {
  MockModelMetaData meta(false, "gemma3");

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, 740, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_Adreno799_UbatchFromOverrides) {
  MockModelMetaData meta(false, "gemma3");

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, 799, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- Finetuning without Adreno: ubatch from overrides ----

TEST_F(TuneConfigMapTest, Finetuning_Gemma3_NoAdreno_UbatchFromOverrides) {
  MockModelMetaData meta(false, "gemma3");

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// ---- Finetuning overrides user inference config ----

TEST_F(TuneConfigMapTest, Finetuning_Adreno830_OverridesUserUbatchHyphen) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["ubatch-size"] = "256";

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, 830, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_Adreno830_OverridesUserUbatchUnderscore) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["ubatch_size"] = "64";

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, 830, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
  EXPECT_EQ(configFilemap_.count("ubatch_size"), 0);
}

// ---- Finetuning context/batch param injection ----

TEST_F(TuneConfigMapTest, Finetuning_ContextLengthInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .contextLength = 256};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("ctx-size"), 1);
  EXPECT_EQ(configFilemap_["ctx-size"], "256");
}

TEST_F(TuneConfigMapTest, Finetuning_BatchSizeInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .batchSize = 64};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("batch-size"), 1);
  EXPECT_EQ(configFilemap_["batch-size"], "64");
}

TEST_F(TuneConfigMapTest, Finetuning_MicroBatchSizeInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .microBatchSize = 16};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

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

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["ctx-size"], "256");
  EXPECT_EQ(configFilemap_["batch-size"], "64");
  EXPECT_EQ(configFilemap_["ubatch-size"], "16");
}

TEST_F(TuneConfigMapTest, Finetuning_DefaultParamsInjected) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["ctx-size"], "128");
  EXPECT_EQ(configFilemap_["batch-size"], "128");
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

TEST_F(TuneConfigMapTest, Finetuning_OverridesUserCtxSizeHyphen) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["ctx-size"] = "512";
  FtOverrides ov{.active = true, .contextLength = 256};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["ctx-size"], "256");
}

TEST_F(TuneConfigMapTest, Finetuning_OverridesUserCtxSizeUnderscore) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["ctx_size"] = "512";
  FtOverrides ov{.active = true, .contextLength = 256};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["ctx-size"], "256");
  EXPECT_EQ(configFilemap_.count("ctx_size"), 0);
}

TEST_F(TuneConfigMapTest, Finetuning_OverridesUserBatchSizeHyphen) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["batch-size"] = "128";
  FtOverrides ov{.active = true, .batchSize = 64};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["batch-size"], "64");
}

TEST_F(TuneConfigMapTest, Finetuning_OverridesUserBatchSizeUnderscore) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["batch_size"] = "128";
  FtOverrides ov{.active = true, .batchSize = 64};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["batch-size"], "64");
  EXPECT_EQ(configFilemap_.count("batch_size"), 0);
}

// Finetuning microBatchSize takes precedence over Adreno 800+ default
TEST_F(TuneConfigMapTest, Finetuning_MicroBatchOverridesAdrenoDefault) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .microBatchSize = 32};

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830, ov);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "32");
}

// Default microBatchSize (128) applies regardless of Adreno version
TEST_F(TuneConfigMapTest, Finetuning_DefaultMicroBatch_Adreno830) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true};

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, 830, ov);

  ASSERT_EQ(configFilemap_.count("ubatch-size"), 1);
  EXPECT_EQ(configFilemap_["ubatch-size"], "128");
}

// Not finetuning (nullopt): no overrides applied
TEST_F(TuneConfigMapTest, NotFinetuning_NoOverridesApplied) {
  MockModelMetaData meta(false, "gemma3");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, std::nullopt);

  EXPECT_EQ(configFilemap_.count("ctx-size"), 0);
  EXPECT_EQ(configFilemap_.count("batch-size"), 0);
  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

// ---- Finetuning KV cache quantization ----

TEST_F(TuneConfigMapTest, Finetuning_NoF16OutProd_CacheTypesSetToF32) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = false};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("cache-type-k"), 1);
  EXPECT_EQ(configFilemap_["cache-type-k"], "f32");
  ASSERT_EQ(configFilemap_.count("cache-type-v"), 1);
  EXPECT_EQ(configFilemap_["cache-type-v"], "f32");
}

TEST_F(TuneConfigMapTest, Finetuning_SupportsF16OutProd_CacheTypesUnchanged) {
  MockModelMetaData meta(false, "gemma3");
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = true};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, Finetuning_DefaultOverrides_CacheTypesUnchanged) {
  MockModelMetaData meta(false, "gemma3");

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, FtOverrides{.active = true});

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, Finetuning_NoF16_UserSetCacheTypeK_Respected) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["cache-type-k"] = "q8_0";
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = false};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_["cache-type-k"], "q8_0");
  ASSERT_EQ(configFilemap_.count("cache-type-v"), 1);
  EXPECT_EQ(configFilemap_["cache-type-v"], "f32");
}

TEST_F(TuneConfigMapTest, Finetuning_NoF16_UserSetCacheTypeV_Respected) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["cache-type-v"] = "q8_0";
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = false};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  ASSERT_EQ(configFilemap_.count("cache-type-k"), 1);
  EXPECT_EQ(configFilemap_["cache-type-k"], "f32");
  EXPECT_EQ(configFilemap_["cache-type-v"], "q8_0");
}

TEST_F(
    TuneConfigMapTest, Finetuning_NoF16_UserSetCacheTypeKUnderscore_Respected) {
  MockModelMetaData meta(false, "gemma3");
  configFilemap_["cache_type_k"] = "q8_0";
  FtOverrides ov{.active = true, .gpuSupportsF16OutProd = false};

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_, meta, std::nullopt, ov);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_["cache_type_k"], "q8_0");
}

TEST_F(TuneConfigMapTest, NotFinetuning_CacheTypesUnchanged) {
  MockModelMetaData meta(false, "gemma3");

  load_fit_normalization::tuneLoadConfigMap(configFilemap_, meta, std::nullopt);

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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
// (the flash-attn predicates are read from both key variants).
TEST_F(
    TuneConfigMapTest,
    AdrenoVulkan_QuantizedKCache_FlashAttnUnderscore_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash_attn"] = "on";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
      load_fit_normalization::tuneLoadConfigMap(
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
  load_fit_normalization::tuneLoadConfigMap(
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

  load_fit_normalization::tuneLoadConfigMap(
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
  load_fit_normalization::tuneLoadConfigMap(
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

  load_fit_normalization::tuneLoadConfigMap(
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
  load_fit_normalization::tuneLoadConfigMap(
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

  load_fit_normalization::tuneLoadConfigMap(
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

  load_fit_normalization::tuneLoadConfigMap(
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

  load_fit_normalization::tuneLoadConfigMap(
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

  load_fit_normalization::tuneLoadConfigMap(
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
  load_fit_normalization::tuneLoadConfigMap(
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
  load_fit_normalization::tuneLoadConfigMap(
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

// ---- QVAC-23763: TurboQuant / PolarQuant rejected on CUDA ----
//
// ggml-cuda ships no TBQ/PQ kernels, so these types abort natively. Standard
// quantized types are fine there, so this mirrors the Metal guard rather than
// the stricter OpenCL one. CPU stays allowed: ggml-tbq-quants is CPU-side.

TEST_F(TuneConfigMapTest, Cuda_RejectsTurboQuantKCacheType) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "tbq4_0";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true,
          /*isCuda=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, Cuda_RejectsPolarQuantVCacheType) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-v"] = "pq3_0";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true,
          /*isCuda=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, Cuda_AllowsStandardQuantizedCacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["cache-type-v"] = "q4_0";

  EXPECT_NO_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true,
          /*isCuda=*/true));
}

TEST_F(TuneConfigMapTest, Cuda_AllowsF16CacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "f16";
  configFilemap_["cache-type-v"] = "f16";

  EXPECT_NO_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true,
          /*isCuda=*/true));
}

// Guard against over-reach. CPU has TBQ kernels and the existing OpenCL/Metal
// errors tell users to switch to it, so a non-CUDA non-GPU call must keep
// accepting TBQ.
TEST_F(TuneConfigMapTest, Cpu_StillAllowsTurboQuantCacheTypes) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "tbq4_0";
  configFilemap_["cache-type-v"] = "pq4_0";

  EXPECT_NO_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          std::nullopt,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/false,
          /*isCuda=*/false));
}

// ---- flash-attn value vocabulary ----
//
// fabric accepts four spellings of "on" and four of "off"; "auto" is a third
// state, not a synonym for either. These pin all three sets against the two
// guards that read them, which answer differently for "auto".

// Helper: plain (non-Adreno) Vulkan GPU — the configuration the q8_0
// auto-default targets.
namespace {
void tuneOnVulkanGpu(
    std::unordered_map<std::string, std::string>& configFilemap,
    const MockModelMetaData& meta) {
  load_fit_normalization::tuneLoadConfigMap(
      configFilemap,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/false,
      /*isGpu=*/true);
}
} // namespace

// --- Truthy synonyms must arm the q8_0 auto-default, exactly like "on". ---
// Before QVAC-24254 the predicate was an equality test against "on", so all
// three of these were classified as flash-attention-off and silently kept f16.

TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnEnabled_DefaultsQ8_0) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "enabled";

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_["cache-type-k"], "q8_0");
  EXPECT_EQ(configFilemap_["cache-type-v"], "q8_0");
}

TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnTrue_DefaultsQ8_0) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "true";

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_["cache-type-k"], "q8_0");
  EXPECT_EQ(configFilemap_["cache-type-v"], "q8_0");
}

TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnOne_DefaultsQ8_0) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "1";

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_["cache-type-k"], "q8_0");
  EXPECT_EQ(configFilemap_["cache-type-v"], "q8_0");
}

// Matching is case-SENSITIVE, exactly as fabric's predicates are. Lowercasing
// would make the addon act on a value fabric then rejects — more permissive
// than the parser it feeds — so a mixed-case value is refused up front naming
// the accepted spellings, rather than being silently read as "off" (skipping
// both guards) or acted on and later failing with an unrelated message.
TEST_F(TuneConfigMapTest, MixedCaseFlashAttn_Rejected) {
  for (const char* value : {"On", "AUTO", "True", "OFF"}) {
    std::unordered_map<std::string, std::string> configFilemap;
    MockModelMetaData meta(false, "llama");
    configFilemap["flash-attn"] = value;

    try {
      tuneOnVulkanGpu(configFilemap, meta);
      FAIL() << "mixed-case flash-attn=" << value << " must throw";
    } catch (const qvac_errors::StatusError& error) {
      const std::string what = error.what();
      EXPECT_NE(what.find("unknown value"), std::string::npos) << what;
      EXPECT_NE(what.find(value), std::string::npos) << what;
    }
  }
}

// Every truthy synonym, under the underscore spelling too. The underscore key
// is the one that reaches the addon through index.d.ts's index signature
// rather than the declared union, so it is the likelier spelling to carry an
// unusual value.
TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_TruthyUnderscore_DefaultsQ8_0) {
  for (const char* value : {"on", "enabled", "true", "1"}) {
    std::unordered_map<std::string, std::string> configFilemap;
    MockModelMetaData meta(false, "llama");
    configFilemap["flash_attn"] = value;

    tuneOnVulkanGpu(configFilemap, meta);

    EXPECT_EQ(configFilemap["cache-type-k"], "q8_0")
        << "flash_attn=" << value << " must arm the q8_0 default";
    EXPECT_EQ(configFilemap["cache-type-v"], "q8_0")
        << "flash_attn=" << value << " must arm the q8_0 default";
  }
}

// BitNet force-disables flash attention only when the key is UNSET, so an
// explicit truthy value overrides it — the caller has opted out of the safety
// default by setting the key at all. Before this PR only 'on' did so and
// 'true' silently did not; making them equivalent is the intended fix, not a
// regression. Pinned because the behaviour widens on top of an arch-specific
// default, which is easy to miss when reading the value table alone.
TEST_F(TuneConfigMapTest, Bitnet_ExplicitTruthySynonym_ArmsQ8_0Default) {
  for (const char* value : {"on", "true"}) {
    std::unordered_map<std::string, std::string> configFilemap;
    MockModelMetaData meta(true, "bitnet");
    configFilemap["flash-attn"] = value;

    tuneOnVulkanGpu(configFilemap, meta);

    EXPECT_EQ(configFilemap["flash-attn"], value)
        << "explicit flash-attn=" << value << " must survive BitNet force-off";
    EXPECT_EQ(configFilemap["cache-type-k"], "q8_0")
        << "flash-attn=" << value << " must arm the q8_0 default on BitNet";
    EXPECT_EQ(configFilemap["cache-type-v"], "q8_0")
        << "flash-attn=" << value << " must arm the q8_0 default on BitNet";
  }
}

// The unset case is unchanged: BitNet still forces flash attention off, and
// the q8_0 default stays closed behind it.
TEST_F(TuneConfigMapTest, Bitnet_FlashAttnUnset_NoQ8_0Default) {
  MockModelMetaData meta(true, "bitnet");

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_["flash-attn"], "off");
  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

// --- "auto" must NOT arm the q8_0 auto-default. ---
// Deliberate, not an oversight: quantizing the V cache makes fabric promote
// AUTO to ENABLED (llama-context.cpp, "required for quantized V cache"),
// skipping the runtime capability probe that "auto" exists to run. The
// package documents 'auto' as "lets qvac-fabric decide" (src/index.ts), so
// the f16 default is what keeps that promise. An explicit cache-type-k/v
// still works for a caller who wants both.

TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnAuto_StaysF16) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "auto";

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
  // The value reaches fabric untouched, so fabric can still decide.
  EXPECT_EQ(configFilemap_["flash-attn"], "auto");
}

TEST_F(
    TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnAutoUnderscore_StaysF16) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash_attn"] = "auto";

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

// fabric's is_autoy also accepts "-1" as AUTO.
TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnMinusOne_StaysF16) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "-1";

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_MetalGpu_FlashAttnAuto_StaysF16) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "auto";

  load_fit_normalization::tuneLoadConfigMap(
      configFilemap_,
      meta,
      std::nullopt,
      FtOverrides{},
      /*isOpenCl=*/false,
      /*isMetal=*/true,
      /*isGpu=*/true);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

// --- Falsey synonyms must still not arm it. ---

TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnDisabled_NotApplied) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "disabled";

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

TEST_F(TuneConfigMapTest, AutoDefault_VulkanGpu_FlashAttnZero_NotApplied) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash-attn"] = "0";

  tuneOnVulkanGpu(configFilemap_, meta);

  EXPECT_EQ(configFilemap_.count("cache-type-k"), 0);
  EXPECT_EQ(configFilemap_.count("cache-type-v"), 0);
}

// --- A value in no set at all is invalid input, not a fourth state. ---
// Rejected here rather than left to fabric, so the caller is told what is
// actually wrong. Letting it through meant the value fell out of every set,
// silently skipped both guards, and surfaced later as whichever unrelated
// error fired first — the Adreno quantized-KV message, typically.
// The empty string is included because notUserSet() treats a present-but-empty
// key as user-set, so it suppresses the "on" default and would otherwise reach
// the passthrough loop as a valueless --flash-attn flag.

TEST_F(TuneConfigMapTest, UnknownFlashAttnValue_Rejected) {
  for (const char* value : {"yes", "no", "", "on ", "enable"}) {
    std::unordered_map<std::string, std::string> configFilemap;
    MockModelMetaData meta(false, "llama");
    configFilemap["flash-attn"] = value;

    try {
      tuneOnVulkanGpu(configFilemap, meta);
      FAIL() << "flash-attn='" << value << "' must throw";
    } catch (const qvac_errors::StatusError& error) {
      const std::string what = error.what();
      EXPECT_NE(what.find("unknown value"), std::string::npos) << what;
      EXPECT_NE(what.find("flash-attn"), std::string::npos) << what;
    }
  }
}

// Same rejection under the underscore spelling, and the message must name the
// key the caller actually used.
TEST_F(TuneConfigMapTest, UnknownFlashAttnValueUnderscore_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["flash_attn"] = "yes";

  try {
    tuneOnVulkanGpu(configFilemap_, meta);
    FAIL() << "flash_attn='yes' must throw";
  } catch (const qvac_errors::StatusError& error) {
    const std::string what = error.what();
    EXPECT_NE(what.find("flash_attn"), std::string::npos) << what;
  }
}

// ---- Adreno 800+ Vulkan crash guard: value vocabulary ----
//
// This guard converts a known coopmat1 driver crash into a clean
// InvalidArgument, so it must fire for every value that can reach fabric with
// flash attention active — including "auto", which quantized V promotes to
// ENABLED and which otherwise resolves to enabled wherever the probe passes.

TEST_F(TuneConfigMapTest, AdrenoVulkan_QuantizedKCache_FlashAttnAuto_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash-attn"] = "auto";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, AdrenoVulkan_QuantizedVCache_FlashAttnAuto_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-v"] = "q8_0";
  configFilemap_["flash-attn"] = "auto";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
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
    AdrenoVulkan_QuantizedKCache_FlashAttnAutoUnderscore_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash_attn"] = "auto";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
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
    TuneConfigMapTest, AdrenoVulkan_QuantizedKCache_FlashAttnEnabled_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash-attn"] = "enabled";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true),
      qvac_errors::StatusError);
}

TEST_F(TuneConfigMapTest, AdrenoVulkan_QuantizedKCache_FlashAttnOne_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash-attn"] = "1";

  EXPECT_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true),
      qvac_errors::StatusError);
}

// Falsey and unknown values leave the guard closed: with flash attention off
// there is no FA shader to crash, and an unknown value is fabric's to reject
// with an accurate message rather than this guard's to misattribute.

TEST_F(
    TuneConfigMapTest, AdrenoVulkan_QuantizedKCache_FlashAttnDisabled_Allowed) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash-attn"] = "disabled";

  EXPECT_NO_THROW(
      load_fit_normalization::tuneLoadConfigMap(
          configFilemap_,
          meta,
          830,
          FtOverrides{},
          /*isOpenCl=*/false,
          /*isMetal=*/false,
          /*isGpu=*/true));
}

// An unknown value on the Adreno path must produce the value error, NOT the
// quantized-KV one. Misattributing it is exactly the diagnostic failure that
// validating up front removes: the caller's real mistake is the spelling.
TEST_F(
    TuneConfigMapTest, AdrenoVulkan_QuantizedKCache_FlashAttnUnknown_Rejected) {
  MockModelMetaData meta(false, "llama");
  configFilemap_["cache-type-k"] = "q8_0";
  configFilemap_["flash-attn"] = "yes";

  try {
    load_fit_normalization::tuneLoadConfigMap(
        configFilemap_,
        meta,
        830,
        FtOverrides{},
        /*isOpenCl=*/false,
        /*isMetal=*/false,
        /*isGpu=*/true);
    FAIL() << "unknown flash-attn value must throw";
  } catch (const qvac_errors::StatusError& error) {
    const std::string what = error.what();
    EXPECT_NE(what.find("unknown value"), std::string::npos) << what;
    EXPECT_EQ(what.find("Adreno"), std::string::npos)
        << "must not misattribute to the Adreno guard: " << what;
  }
}

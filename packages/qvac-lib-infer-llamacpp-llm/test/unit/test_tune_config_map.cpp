#include <optional>
#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

using test_common::MockModelMetaData;

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

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchHyphen_Respected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch-size"] = "256";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_["ubatch-size"], "256");
}

TEST_F(TuneConfigMapTest, Bitnet_Adreno830_UserSetUbatchUnderscore_Respected) {
  MockModelMetaData meta(true, "bitnet");
  configFilemap_["ubatch_size"] = "64";

  LlamaModel::tuneConfigMap(configFilemap_, meta, 830);

  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
  EXPECT_EQ(configFilemap_["ubatch_size"], "64");
}

// ---- Edge: Adreno 799 (just below threshold) ----

TEST_F(TuneConfigMapTest, Bitnet_Adreno799_UbatchUnchanged) {
  MockModelMetaData meta(true, "bitnet");

  LlamaModel::tuneConfigMap(configFilemap_, meta, 799);

  EXPECT_EQ(configFilemap_.count("ubatch-size"), 0);
}

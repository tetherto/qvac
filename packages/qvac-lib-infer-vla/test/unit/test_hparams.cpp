#include <gtest/gtest.h>

#include "model-interface/smolvla.hpp"

TEST(SmolvlaHparams, DefaultsMatchSmolVlaConfig) {
  smolvla_hparams hp;
  EXPECT_EQ(hp.vision_image_size, 512);
  EXPECT_EQ(hp.vision_patch_size, 16);
  EXPECT_EQ(hp.vision_hidden_size, 768);
  EXPECT_EQ(hp.text_hidden_size, 960);
  EXPECT_EQ(hp.expert_hidden_size, 720);
  EXPECT_EQ(hp.chunk_size, 50);
  EXPECT_EQ(hp.max_action_dim, 32);
  EXPECT_EQ(hp.max_state_dim, 32);
}

TEST(SmolvlaHparams, DerivedShapesMatchPaper) {
  smolvla_hparams hp;
  // (512/16)^2 = 1024 patches per image
  EXPECT_EQ(hp.patches_per_image(), 1024);
  // 1024 / (4*4) = 64 tokens per image
  EXPECT_EQ(hp.tokens_per_image(), 64);
  // 768 * 4 * 4 = 12288 connector input features
  EXPECT_EQ(hp.connector_in_features(), 12288);
}

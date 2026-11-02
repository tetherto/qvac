// defaultImageMaxTokens picks the image-token cap a load applies when the
// caller sets no image_max_tokens, from the mmproj's vision projector type.
#include <gtest/gtest.h>

#include "model-interface/ImageTokenBudget.hpp"

TEST(ImageTokenBudget, QwenVlMergersCapAt2048) {
  EXPECT_EQ(defaultImageMaxTokens("qwen2vl_merger"), 2048);
  EXPECT_EQ(defaultImageMaxTokens("qwen2.5vl_merger"), 2048);
  EXPECT_EQ(defaultImageMaxTokens("qwen3vl_merger"), 2048);
  EXPECT_EQ(defaultImageMaxTokens("qwen2.5o"), 2048);
}

// Gemma 4's encoder allows 1120 tokens; a large image there needs four times
// the prefill and compute buffer of 280.
TEST(ImageTokenBudget, Gemma4VisionCapsAt280) {
  EXPECT_EQ(defaultImageMaxTokens("gemma4v"), 280);
  EXPECT_EQ(defaultImageMaxTokens("gemma4uv"), 280);
}

TEST(ImageTokenBudget, OtherProjectorsKeepTheEncoderBudget) {
  EXPECT_EQ(defaultImageMaxTokens(""), 0);
  EXPECT_EQ(defaultImageMaxTokens("gemma3"), 0);
  EXPECT_EQ(defaultImageMaxTokens("gemma4a"), 0);
  EXPECT_EQ(defaultImageMaxTokens("gemma4ua"), 0);
  EXPECT_EQ(defaultImageMaxTokens("pixtral"), 0);
  EXPECT_EQ(defaultImageMaxTokens("lfm2"), 0);
  EXPECT_EQ(defaultImageMaxTokens("idefics3"), 0);
}

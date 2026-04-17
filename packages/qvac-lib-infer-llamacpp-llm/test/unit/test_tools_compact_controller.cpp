#include <gtest/gtest.h>

#include "model-interface/ToolsCompactController.hpp"

TEST(ToolsCompactControllerTest, AnchorCanReachFirstMessageBoundaryAfterSlide) {
  ToolsCompactController controller(true);

  // Simulate setting anchor position via onTokenize + onEvalComplete
  controller.onTokenize(200, 120); // with tools: 200, without: 120
  controller.onEvalComplete(200, 200);

  // Anchor should be at 200 - (200 - 120) = 120
  EXPECT_EQ(controller.anchor(), 120);

  constexpr llama_pos firstMsgTokens = 100;
  controller.onSlide(/*discard=*/20, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);

  // Once the anchor reaches firstMsgTokens, further slide adjustments stop.
  controller.onSlide(/*discard=*/5, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);
}

TEST(ToolsCompactControllerTest, DegenerateAnchorIsNotUsableForPostGenerationTrim) {
  ToolsCompactController controller(true);

  constexpr llama_pos firstMsgTokens = 100;
  constexpr llama_pos nPast = 180;

  // Set anchor to firstMsgTokens (degenerate case)
  controller.onTokenize(200, 100); // with: 200, without: 100
  controller.onEvalComplete(100, 200);
  // Anchor = 100 - (200 - 100) = 0, not what we want for degenerate test

  // Manually create degenerate state via sliding to firstMsgTokens
  // Start with anchor > firstMsgTokens and slide down
  controller.reset();
  controller.onTokenize(220, 100);
  controller.onEvalComplete(220, 220);
  // anchor = 220 - (220 - 100) = 100 = firstMsgTokens

  // Now anchor == firstMsgTokens (degenerate)
  EXPECT_TRUE(controller.degenerateBoundary(firstMsgTokens));

  const bool shouldTrim = controller.usableBoundary(firstMsgTokens) &&
                          nPast > controller.anchor();
  EXPECT_FALSE(shouldTrim);
}

TEST(ToolsCompactControllerTest, PositiveNonDegenerateAnchorIsUsableForPostTrim) {
  ToolsCompactController controller(true);

  constexpr llama_pos firstMsgTokens = 100;
  constexpr llama_pos nPast = 180;

  // Set anchor to 80 (non-degenerate, below firstMsgTokens)
  // anchor = nPast - (total - conversationOnly)
  // 80 = nPast - (total - conversationOnly)
  // We need total and conversationOnly such that anchor lands at 80
  // Let's say total = 150, conversationOnly = 50
  // anchor = 130 - (150 - 50) = 130 - 100 = 30, not quite
  // Let's try: total = 100, conversationOnly = 80, nPast = 100
  // anchor = 100 - (100 - 80) = 80
  controller.onTokenize(100, 80);
  controller.onEvalComplete(100, 100);
  EXPECT_EQ(controller.anchor(), 80);

  const bool shouldTrim = controller.usableBoundary(firstMsgTokens) &&
                          nPast > controller.anchor();
  EXPECT_TRUE(shouldTrim);
}

TEST(ToolsCompactControllerTest, SlidingUnclampedFullDiscard) {
  ToolsCompactController controller(true);

  constexpr llama_pos firstMsgTokens = 11;
  constexpr llama_pos anchorBefore = 241;
  constexpr llama_pos nDiscarded = 32;

  // Set anchor via onTokenize + onEvalComplete
  // We need anchor = anchorBefore = 241
  // anchor = nPast - (totalTokens - conversationOnlyTokens)
  // Let's say nPast = anchorBefore + 100 = 341, totalTokens = 341,
  // conversationOnly = 241
  // anchor = 341 - (341 - 241) = 341 - 100 = 241
  controller.onTokenize(341, 241);
  controller.onEvalComplete(341, 341);
  EXPECT_EQ(controller.anchor(), anchorBefore);

  const llama_pos discard = controller.clampDiscard(nDiscarded, firstMsgTokens);
  controller.onSlide(discard, firstMsgTokens);

  EXPECT_EQ(discard, nDiscarded);
  EXPECT_EQ(controller.anchor(), anchorBefore - nDiscarded);
  EXPECT_GE(controller.anchor(), firstMsgTokens);
}

TEST(ToolsCompactControllerTest, EnabledReturnsTrueWhenConstructedWithTrue) {
  ToolsCompactController controller(true);
  EXPECT_TRUE(controller.enabled());
}

TEST(ToolsCompactControllerTest, EnabledReturnsFalseWhenConstructedWithFalse) {
  ToolsCompactController controller(false);
  EXPECT_FALSE(controller.enabled());
}

TEST(ToolsCompactControllerTest, AnchorIsMinusOneInitially) {
  ToolsCompactController controller(true);
  EXPECT_EQ(controller.anchor(), -1);
}

TEST(ToolsCompactControllerTest, ResetClearsAnchor) {
  ToolsCompactController controller(true);

  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);

  controller.reset();
  EXPECT_EQ(controller.anchor(), -1);
}

TEST(ToolsCompactControllerTest, ClampDiscardPreservesToolRegion) {
  ToolsCompactController controller(true);

  constexpr llama_pos firstMsgTokens = 50;

  // Set anchor at 100
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);

  // Request discard of 80 tokens, but anchor is at 100, firstMsgTokens is 50
  // safeLimit = anchor - firstMsgTokens = 100 - 50 = 50
  // clampDiscard should return min(80, 50) = 50
  llama_pos clamped = controller.clampDiscard(80, firstMsgTokens);
  EXPECT_EQ(clamped, 50);
}

TEST(ToolsCompactControllerTest, ClampDiscardReturnsRequestedWhenSafe) {
  ToolsCompactController controller(true);

  constexpr llama_pos firstMsgTokens = 10;

  // Set anchor at 200
  controller.onTokenize(300, 200);
  controller.onEvalComplete(300, 300);
  EXPECT_EQ(controller.anchor(), 200);

  // Request discard of 30 tokens
  // safeLimit = anchor - firstMsgTokens = 200 - 10 = 190
  // clampDiscard should return min(30, 190) = 30
  llama_pos clamped = controller.clampDiscard(30, firstMsgTokens);
  EXPECT_EQ(clamped, 30);
}

TEST(ToolsCompactControllerTest, OnSlideAdjustsAnchor) {
  ToolsCompactController controller(true);

  constexpr llama_pos firstMsgTokens = 50;

  // Set anchor at 100
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);

  // Slide by 30
  controller.onSlide(30, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 70);
}

TEST(ToolsCompactControllerTest, OnSlideStopsAtFirstMsgTokens) {
  ToolsCompactController controller(true);

  constexpr llama_pos firstMsgTokens = 80;

  // Set anchor at 100
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);

  // Slide by 30 would take anchor to 70, but firstMsgTokens is 80
  // Anchor should clamp to firstMsgTokens
  controller.onSlide(30, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);
}

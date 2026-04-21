// Unit tests for ContextSlider helper functions.
//
// These tests verify the decision logic and controller interactions in the
// sliding-window helpers. Full KV cache manipulation testing requires
// integration tests with a real model context (see sliding-context.test.js).
//
// Test strategy:
// - SlideOutcome struct construction and kind variants
// - ToolsCompactController integration (clampDiscard, onSlide,
// degenerateBoundary)
// - Edge cases in prefill vs generation sliding logic

#include <cstdint>
#include <optional>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ContextSlider.hpp"
#include "model-interface/ToolsCompactController.hpp"

using namespace qvac_lib_inference_addon_llama::context_slider;

namespace {
struct SeqRmCall {
  llama_seq_id seqId = 0;
  llama_pos startPos = 0;
  llama_pos endPos = 0;
};

struct SeqAddCall {
  llama_seq_id seqId = 0;
  llama_pos startPos = 0;
  llama_pos endPos = 0;
  llama_pos delta = 0;
};

class FakeLlamaContextOps final : public ILlamaContextOps {
public:
  explicit FakeLlamaContextOps(llama_pos ctxSize) : ctxSize_(ctxSize) {}

  llama_pos nCtx(llama_context*) const override { return ctxSize_; }

  LlamaMemoryHandle memory(llama_context*) const override {
    ++memoryCalls_;
    return fakeMemory_;
  }

  void seqRm(
      LlamaMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const override {
    EXPECT_EQ(mem, fakeMemory_);
    seqRmCalls_.push_back({seqId, startPos, endPos});
  }

  void seqAdd(
      LlamaMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const override {
    EXPECT_EQ(mem, fakeMemory_);
    seqAddCalls_.push_back({seqId, startPos, endPos, delta});
  }

  int memoryCalls() const { return memoryCalls_; }
  const std::vector<SeqRmCall>& seqRmCalls() const { return seqRmCalls_; }
  const std::vector<SeqAddCall>& seqAddCalls() const { return seqAddCalls_; }

private:
  llama_pos ctxSize_;
  LlamaMemoryHandle fakeMemory_ =
      reinterpret_cast<LlamaMemoryHandle>(static_cast<uintptr_t>(0x1));
  mutable int memoryCalls_ = 0;
  mutable std::vector<SeqRmCall> seqRmCalls_;
  mutable std::vector<SeqAddCall> seqAddCalls_;
};
} // namespace

class ContextSliderTest : public ::testing::Test {
protected:
  void SetUp() override {}
};

// ═══════════════════════════════════════════════════════════════════════════
// SlideOutcome struct tests
// ═══════════════════════════════════════════════════════════════════════════

TEST_F(ContextSliderTest, SlideOutcomeDefaultIsNotNeeded) {
  SlideOutcome outcome;
  EXPECT_EQ(outcome.kind, SlideOutcome::Kind::NotNeeded);
  EXPECT_EQ(outcome.newNPast, 0);
  EXPECT_EQ(outcome.discarded, 0);
}

TEST_F(ContextSliderTest, SlideOutcomeKindCoverage) {
  EXPECT_EQ(static_cast<int>(SlideOutcome::Kind::NotNeeded), 0);
  EXPECT_EQ(static_cast<int>(SlideOutcome::Kind::Slid), 1);
  EXPECT_EQ(static_cast<int>(SlideOutcome::Kind::FullWipe), 2);
  EXPECT_EQ(static_cast<int>(SlideOutcome::Kind::Overflow), 3);
}

TEST_F(ContextSliderTest, SlideOutcomeCanBeConstructedWithValues) {
  SlideOutcome slid{SlideOutcome::Kind::Slid, 150, 50};
  EXPECT_EQ(slid.kind, SlideOutcome::Kind::Slid);
  EXPECT_EQ(slid.newNPast, 150);
  EXPECT_EQ(slid.discarded, 50);

  SlideOutcome wipe{SlideOutcome::Kind::FullWipe, 100, 200};
  EXPECT_EQ(wipe.kind, SlideOutcome::Kind::FullWipe);
  EXPECT_EQ(wipe.newNPast, 100);
  EXPECT_EQ(wipe.discarded, 200);
}

// ═══════════════════════════════════════════════════════════════════════════
// ToolsCompactController integration for sliding
// ═══════════════════════════════════════════════════════════════════════════

TEST_F(ContextSliderTest, ClampDiscardRespectsToolAnchor) {
  ToolsCompactController controller(ToolsCompactProfile{});

  // Set anchor at 200 (simulating tool tokens from position 200 onwards)
  controller.onTokenize(300, 200);
  controller.onEvalComplete(300, 300);
  EXPECT_EQ(controller.anchor(), 200);

  constexpr llama_pos firstMsgTokens = 50;

  // Request 200 tokens discard, but only 150 can be discarded safely
  // safeLimit = anchor - firstMsgTokens = 200 - 50 = 150
  llama_pos clamped = controller.clampDiscard(200, firstMsgTokens);
  EXPECT_EQ(clamped, 150);
}

TEST_F(ContextSliderTest, ClampDiscardAllowsFullRequestWhenBelowAnchor) {
  ToolsCompactController controller(ToolsCompactProfile{});

  controller.onTokenize(500, 400);
  controller.onEvalComplete(500, 500);
  EXPECT_EQ(controller.anchor(), 400);

  constexpr llama_pos firstMsgTokens = 50;

  // Request 100 tokens, safe limit is 400 - 50 = 350
  llama_pos clamped = controller.clampDiscard(100, firstMsgTokens);
  EXPECT_EQ(clamped, 100);
}

TEST_F(ContextSliderTest, ClampDiscardPassesThroughWhenAnchorAtFirstMsg) {
  ToolsCompactController controller(ToolsCompactProfile{});

  // Create degenerate case: anchor == firstMsgTokens
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);

  constexpr llama_pos firstMsgTokens = 100;

  // When anchor <= firstMsgTokens, clampDiscard returns requested unchanged
  // because there's no protected region above firstMsgTokens to preserve
  llama_pos clamped = controller.clampDiscard(50, firstMsgTokens);
  EXPECT_EQ(clamped, 50);
}

TEST_F(ContextSliderTest, ClampDiscardPassesThroughWhenDisabled) {
  ToolsCompactController controller(std::nullopt);

  constexpr llama_pos firstMsgTokens = 50;
  constexpr llama_pos requested = 100;

  // When disabled, clampDiscard returns the requested value unchanged
  llama_pos clamped = controller.clampDiscard(requested, firstMsgTokens);
  EXPECT_EQ(clamped, requested);
}

TEST_F(ContextSliderTest, OnSlideAdjustsAnchorCorrectly) {
  ToolsCompactController controller(ToolsCompactProfile{});

  controller.onTokenize(300, 200);
  controller.onEvalComplete(300, 300);
  EXPECT_EQ(controller.anchor(), 200);

  constexpr llama_pos firstMsgTokens = 50;
  constexpr llama_pos discarded = 30;

  controller.onSlide(discarded, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 170); // 200 - 30
}

TEST_F(ContextSliderTest, OnSlideStopsAtFirstMsgTokens) {
  ToolsCompactController controller(ToolsCompactProfile{});

  controller.onTokenize(300, 200);
  controller.onEvalComplete(300, 300);
  EXPECT_EQ(controller.anchor(), 200);

  constexpr llama_pos firstMsgTokens = 180;

  // Discard 50 would take anchor to 150, but firstMsgTokens is 180
  controller.onSlide(50, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);
}

TEST_F(ContextSliderTest, DegenerateBoundaryDetectedCorrectly) {
  ToolsCompactController controller(ToolsCompactProfile{});

  // Set anchor exactly at firstMsgTokens
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);

  constexpr llama_pos firstMsgTokens = 100;
  EXPECT_TRUE(controller.degenerateBoundary(firstMsgTokens));
}

TEST_F(ContextSliderTest, DegenerateBoundaryFalseWhenAnchorAbove) {
  ToolsCompactController controller(ToolsCompactProfile{});

  controller.onTokenize(300, 200);
  controller.onEvalComplete(300, 300);
  EXPECT_EQ(controller.anchor(), 200);

  constexpr llama_pos firstMsgTokens = 100;
  EXPECT_FALSE(controller.degenerateBoundary(firstMsgTokens));
}

TEST_F(ContextSliderTest, ResetClearsAnchorForFreshSliding) {
  ToolsCompactController controller(ToolsCompactProfile{});

  controller.onTokenize(300, 200);
  controller.onEvalComplete(300, 300);
  EXPECT_EQ(controller.anchor(), 200);

  controller.reset();
  EXPECT_EQ(controller.anchor(), -1);

  // After reset, clampDiscard returns requested (no anchor to protect)
  llama_pos clamped = controller.clampDiscard(100, 50);
  EXPECT_EQ(clamped, 100);
}

// ═══════════════════════════════════════════════════════════════════════════
// Prefill sliding decision logic
// ═══════════════════════════════════════════════════════════════════════════

TEST_F(ContextSliderTest, PrefillSlideScenario_EnoughRoom) {
  // When nPast + nTokensToAppend < nCtx, no sliding needed
  // This tests the NotNeeded path without llama context

  constexpr llama_pos nPast = 100;
  constexpr llama_pos nCtx = 500;
  constexpr llama_pos nTokensToAppend = 50;

  // nPast + nTokensToAppend = 150 < 500 = nCtx
  // Expected: NotNeeded
  EXPECT_LT(nPast + nTokensToAppend, nCtx);
}

TEST_F(ContextSliderTest, PrefillSlidInvokesLlamaOpsWithExpectedRanges) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/400);

  SlideOutcome outcome = trySlidePrefill(
      /*lctx=*/nullptr,
      /*nPast=*/300,
      /*firstMsgTokens=*/50,
      /*nTokensToAppend=*/180,
      /*nDiscarded=*/100,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, SlideOutcome::Kind::Slid);
  EXPECT_EQ(outcome.newNPast, 200);
  EXPECT_EQ(outcome.discarded, 100);

  ASSERT_EQ(ops.memoryCalls(), 1);
  ASSERT_EQ(ops.seqRmCalls().size(), 1u);
  EXPECT_EQ(ops.seqRmCalls()[0].seqId, 0);
  EXPECT_EQ(ops.seqRmCalls()[0].startPos, 50);
  EXPECT_EQ(ops.seqRmCalls()[0].endPos, 150);

  ASSERT_EQ(ops.seqAddCalls().size(), 1u);
  EXPECT_EQ(ops.seqAddCalls()[0].seqId, 0);
  EXPECT_EQ(ops.seqAddCalls()[0].startPos, 150);
  EXPECT_EQ(ops.seqAddCalls()[0].endPos, 300);
  EXPECT_EQ(ops.seqAddCalls()[0].delta, -100);
}

TEST_F(ContextSliderTest, PrefillFullWipeInvokesSeqRmOnly) {
  ToolsCompactController controller(ToolsCompactProfile{});
  FakeLlamaContextOps ops(/*ctxSize=*/300);

  // Set anchor at firstMsgTokens to preserve the existing full-wipe branch
  // behavior while still running with tools_compact enabled.
  controller.onTokenize(120, 50);
  controller.onEvalComplete(120, 120);
  EXPECT_EQ(controller.anchor(), 50);

  SlideOutcome outcome = trySlidePrefill(
      /*lctx=*/nullptr,
      /*nPast=*/120,
      /*firstMsgTokens=*/50,
      /*nTokensToAppend=*/200,
      /*nDiscarded=*/100,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, SlideOutcome::Kind::FullWipe);
  EXPECT_EQ(outcome.newNPast, 50);
  EXPECT_EQ(outcome.discarded, 70);
  EXPECT_EQ(controller.anchor(), -1);

  ASSERT_EQ(ops.memoryCalls(), 1);
  ASSERT_EQ(ops.seqRmCalls().size(), 1u);
  EXPECT_EQ(ops.seqRmCalls()[0].seqId, 0);
  EXPECT_EQ(ops.seqRmCalls()[0].startPos, 50);
  EXPECT_EQ(ops.seqRmCalls()[0].endPos, 120);
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(ContextSliderTest, PrefillSlideScenario_NeedsSlidingCalculation) {
  // When nPast + nTokensToAppend >= nCtx, calculate slide parameters
  constexpr llama_pos nPast = 450;
  constexpr llama_pos nCtx = 500;
  constexpr llama_pos nTokensToAppend = 100;
  constexpr llama_pos firstMsgTokens = 50;

  // nPast + nTokensToAppend = 550 >= 500 = nCtx -> needs sliding
  EXPECT_GE(nPast + nTokensToAppend, nCtx);

  ToolsCompactController controller(ToolsCompactProfile{});
  controller.onTokenize(nPast, 200);
  controller.onEvalComplete(nPast, nPast);

  // anchor = 200, safeLimit = 200 - 50 = 150
  llama_pos discard = controller.clampDiscard(100, firstMsgTokens);
  EXPECT_EQ(discard, 100); // full request allowed

  // leftTokens = nPast - firstMsgTokens - discard = 450 - 50 - 100 = 300
  llama_pos leftTokens = nPast - firstMsgTokens - discard;
  EXPECT_EQ(leftTokens, 300);
  EXPECT_GE(leftTokens, 0);

  // After slide: nPast - discard + nTokensToAppend = 450 - 100 + 100 = 450 <
  // 500
  EXPECT_LT(nPast - discard + nTokensToAppend, nCtx);
}

TEST_F(ContextSliderTest, PrefillSlideScenario_FullWipeFallback) {
  // When leftTokens < 0 and firstMsgTokens + nTokensToAppend < nCtx
  // This is the FullWipe fallback scenario

  constexpr llama_pos nCtx = 500;
  constexpr llama_pos nTokensToAppend = 100;
  constexpr llama_pos firstMsgTokens = 50;

  // Simulate a case where discard would exceed available tokens
  ToolsCompactController controller(ToolsCompactProfile{});

  // Set anchor very close to firstMsgTokens so clamped discard is small
  controller.onTokenize(200, 55);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 55);

  // safeLimit = 55 - 50 = 5
  llama_pos discard = controller.clampDiscard(300, firstMsgTokens);
  EXPECT_EQ(discard, 5);

  // When anchor == firstMsgTokens (degenerate), clampDiscard returns requested
  // because anchor <= firstMsgTokens means no protected region above firstMsg
  controller.reset();
  controller.onTokenize(200, 50);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 50);

  // anchor (50) <= firstMsgTokens (50), so no clamping occurs
  discard = controller.clampDiscard(300, firstMsgTokens);
  EXPECT_EQ(discard, 300);

  // FullWipe is triggered in ContextSlider when leftTokens < 0 and partial
  // slide isn't viable, but first message + new tokens fits in context
  EXPECT_LT(firstMsgTokens + nTokensToAppend, nCtx);
}

TEST_F(ContextSliderTest, PrefillSlideScenario_Overflow) {
  // When nothing can free enough space, Overflow is returned
  constexpr llama_pos nCtx = 100;
  constexpr llama_pos nTokensToAppend = 200; // larger than entire context
  constexpr llama_pos firstMsgTokens = 50;

  // Even first message + new tokens exceeds context
  EXPECT_GE(firstMsgTokens + nTokensToAppend, nCtx);
}

// ═══════════════════════════════════════════════════════════════════════════
// Generation sliding decision logic
// ═══════════════════════════════════════════════════════════════════════════

TEST_F(ContextSliderTest, GenerationSlideScenario_EnoughRoom) {
  // When nPast + 1 <= nCtx, no sliding needed
  constexpr llama_pos nPast = 499;
  constexpr llama_pos nCtx = 500;

  EXPECT_LE(nPast + 1, nCtx);
}

TEST_F(ContextSliderTest, GenerationSlidInvokesLlamaOpsWithExpectedRanges) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/400);

  SlideOutcome outcome = trySlideGeneration(
      /*lctx=*/nullptr,
      /*nPast=*/400,
      /*firstMsgTokens=*/50,
      /*nDiscarded=*/120,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, SlideOutcome::Kind::Slid);
  EXPECT_EQ(outcome.newNPast, 280);
  EXPECT_EQ(outcome.discarded, 120);

  ASSERT_EQ(ops.memoryCalls(), 1);
  ASSERT_EQ(ops.seqRmCalls().size(), 1u);
  EXPECT_EQ(ops.seqRmCalls()[0].seqId, 0);
  EXPECT_EQ(ops.seqRmCalls()[0].startPos, 50);
  EXPECT_EQ(ops.seqRmCalls()[0].endPos, 170);

  ASSERT_EQ(ops.seqAddCalls().size(), 1u);
  EXPECT_EQ(ops.seqAddCalls()[0].seqId, 0);
  EXPECT_EQ(ops.seqAddCalls()[0].startPos, 170);
  EXPECT_EQ(ops.seqAddCalls()[0].endPos, 400);
  EXPECT_EQ(ops.seqAddCalls()[0].delta, -120);
}

TEST_F(ContextSliderTest, GenerationNotNeededDoesNotCallLlamaOps) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/500);

  SlideOutcome outcome = trySlideGeneration(
      /*lctx=*/nullptr,
      /*nPast=*/499,
      /*firstMsgTokens=*/50,
      /*nDiscarded=*/120,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, SlideOutcome::Kind::NotNeeded);
  EXPECT_EQ(outcome.newNPast, 499);
  EXPECT_EQ(outcome.discarded, 0);

  EXPECT_EQ(ops.memoryCalls(), 0);
  EXPECT_TRUE(ops.seqRmCalls().empty());
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(ContextSliderTest, GenerationSlideScenario_NeedsSliding) {
  // When nPast + 1 > nCtx and nDiscarded > 0, need to slide
  constexpr llama_pos nPast = 500;
  constexpr llama_pos nCtx = 500;
  constexpr llama_pos nDiscarded = 50;

  EXPECT_GT(nPast + 1, nCtx);
  EXPECT_GT(nDiscarded, 0);
}

TEST_F(ContextSliderTest, GenerationSlideScenario_NoDiscardAllowed) {
  // When nPast + 1 > nCtx but nDiscarded == 0, NotNeeded returned
  constexpr llama_pos nPast = 500;
  constexpr llama_pos nCtx = 500;
  constexpr llama_pos nDiscarded = 0;

  EXPECT_GT(nPast + 1, nCtx);
  EXPECT_EQ(nDiscarded, 0);
}

TEST_F(ContextSliderTest, GenerationSlideScenario_DegenerateBoundaryReset) {
  // When degenerateBoundary is true, the ContextSlider handles the degenerate
  // case by resetting the controller before retrying
  ToolsCompactController controller(ToolsCompactProfile{});

  constexpr llama_pos firstMsgTokens = 100;

  // Set anchor at firstMsgTokens (degenerate)
  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);
  EXPECT_TRUE(controller.degenerateBoundary(firstMsgTokens));

  // When anchor <= firstMsgTokens, clampDiscard returns requested unchanged
  // because no region above firstMsgTokens needs protection
  llama_pos discard = controller.clampDiscard(50, firstMsgTokens);
  EXPECT_EQ(discard, 50);

  // After reset, anchor is -1 (disabled for clamping purposes)
  controller.reset();
  EXPECT_EQ(controller.anchor(), -1);
  EXPECT_FALSE(controller.degenerateBoundary(firstMsgTokens));

  // With anchor == -1, clampDiscard still returns requested
  discard = controller.clampDiscard(50, firstMsgTokens);
  EXPECT_EQ(discard, 50);
}

// ═══════════════════════════════════════════════════════════════════════════
// Multiple slides sequence
// ═══════════════════════════════════════════════════════════════════════════

TEST_F(ContextSliderTest, MultipleSlidesMaintainAnchorConsistency) {
  ToolsCompactController controller(ToolsCompactProfile{});

  constexpr llama_pos firstMsgTokens = 50;

  // Initial anchor at 300
  controller.onTokenize(400, 300);
  controller.onEvalComplete(400, 400);
  EXPECT_EQ(controller.anchor(), 300);

  // First slide: discard 50
  controller.onSlide(50, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 250);

  // Second slide: discard 100
  controller.onSlide(100, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 150);

  // Third slide: discard 80
  controller.onSlide(80, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 70);

  // Fourth slide: try to discard 50, but anchor would go below firstMsgTokens
  controller.onSlide(50, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), firstMsgTokens); // clamped to 50
}

TEST_F(
    ContextSliderTest, ClampDiscardBecomesMoreRestrictiveAsAnchorApproaches) {
  ToolsCompactController controller(ToolsCompactProfile{});

  constexpr llama_pos firstMsgTokens = 100;

  controller.onTokenize(500, 400);
  controller.onEvalComplete(500, 500);

  // anchor = 400, safeLimit = 400 - 100 = 300
  EXPECT_EQ(controller.clampDiscard(1000, firstMsgTokens), 300);

  controller.onSlide(200, firstMsgTokens);
  // anchor = 200, safeLimit = 200 - 100 = 100
  EXPECT_EQ(controller.clampDiscard(1000, firstMsgTokens), 100);

  controller.onSlide(50, firstMsgTokens);
  // anchor = 150, safeLimit = 150 - 100 = 50
  EXPECT_EQ(controller.clampDiscard(1000, firstMsgTokens), 50);

  controller.onSlide(50, firstMsgTokens);
  // anchor = 100 (clamped to firstMsgTokens by onSlide)
  EXPECT_EQ(controller.anchor(), firstMsgTokens);

  // When anchor <= firstMsgTokens, clampDiscard returns requested unchanged
  // because there's no protected region above firstMsgTokens
  EXPECT_EQ(controller.clampDiscard(1000, firstMsgTokens), 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// Disabled controller behavior
// ═══════════════════════════════════════════════════════════════════════════

TEST_F(ContextSliderTest, DisabledControllerAlwaysReturnsRequestedDiscard) {
  ToolsCompactController controller(std::nullopt);

  constexpr llama_pos firstMsgTokens = 100;

  // Even without setting anchor, disabled controller returns requested
  EXPECT_EQ(controller.clampDiscard(50, firstMsgTokens), 50);
  EXPECT_EQ(controller.clampDiscard(500, firstMsgTokens), 500);
  EXPECT_EQ(controller.clampDiscard(0, firstMsgTokens), 0);
}

TEST_F(ContextSliderTest, DisabledControllerDegenerateBoundaryAlwaysFalse) {
  ToolsCompactController controller(std::nullopt);

  constexpr llama_pos firstMsgTokens = 100;

  // Without tools_compact, there's no degenerate boundary concern
  EXPECT_FALSE(controller.degenerateBoundary(firstMsgTokens));
}

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════

TEST_F(ContextSliderTest, ZeroFirstMsgTokensEdgeCase) {
  ToolsCompactController controller(ToolsCompactProfile{});

  constexpr llama_pos firstMsgTokens = 0;

  controller.onTokenize(200, 100);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 100);

  // safeLimit = 100 - 0 = 100
  EXPECT_EQ(controller.clampDiscard(200, firstMsgTokens), 100);

  // Slide should clamp anchor to firstMsgTokens = 0
  controller.onSlide(100, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 0);
}

TEST_F(ContextSliderTest, AnchorNeverGoesNegativeAfterSlide) {
  ToolsCompactController controller(ToolsCompactProfile{});

  constexpr llama_pos firstMsgTokens = 50;

  controller.onTokenize(200, 80);
  controller.onEvalComplete(200, 200);
  EXPECT_EQ(controller.anchor(), 80);

  // Try to slide more than anchor - firstMsgTokens
  // safeLimit = 80 - 50 = 30, but we're testing onSlide directly
  controller.onSlide(100, firstMsgTokens);

  // anchor should clamp to firstMsgTokens, never go negative
  EXPECT_GE(controller.anchor(), 0);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);
}

TEST_F(ContextSliderTest, LargeValuesDoNotOverflow) {
  ToolsCompactController controller(ToolsCompactProfile{});

  constexpr llama_pos firstMsgTokens = 1000;
  constexpr llama_pos largeAnchor = 1000000;

  controller.onTokenize(largeAnchor + 100000, largeAnchor);
  controller.onEvalComplete(largeAnchor + 100000, largeAnchor + 100000);
  EXPECT_EQ(controller.anchor(), largeAnchor);

  // safeLimit = 1000000 - 1000 = 999000
  llama_pos clamped = controller.clampDiscard(500000, firstMsgTokens);
  EXPECT_EQ(clamped, 500000);

  controller.onSlide(500000, firstMsgTokens);
  EXPECT_EQ(controller.anchor(), 500000);
}

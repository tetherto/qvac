// Owns ContextSlider orchestration via trySlidePrefill/trySlideGeneration.
// Controller primitive behavior is intentionally covered in
// test_tools_compact_controller.cpp.

#include <cstdint>
#include <optional>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ContextSlider.hpp"
#include "model-interface/ToolsCompactController.hpp"

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

class FakeLlamaContextOps final : public IContextSliderOps {
public:
  explicit FakeLlamaContextOps(llama_pos ctxSize) : ctxSize_(ctxSize) {}

  llama_pos nCtx(llama_context*) const override { return ctxSize_; }

  ContextSliderMemoryHandle memory(llama_context*) const override {
    ++memoryCalls_;
    return fakeMemory_;
  }

  void seqRm(
      ContextSliderMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const override {
    EXPECT_EQ(mem, fakeMemory_);
    seqRmCalls_.push_back({seqId, startPos, endPos});
  }

  void seqAdd(
      ContextSliderMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const override {
    EXPECT_EQ(mem, fakeMemory_);
    seqAddCalls_.push_back({seqId, startPos, endPos, delta});
  }

  int memoryCalls() const { return memoryCalls_; }
  const std::vector<SeqRmCall>& seqRmCalls() const { return seqRmCalls_; }
  const std::vector<SeqAddCall>& seqAddCalls() const { return seqAddCalls_; }

private:
  llama_pos ctxSize_;
  ContextSliderMemoryHandle fakeMemory_ =
      reinterpret_cast<ContextSliderMemoryHandle>(static_cast<uintptr_t>(0x1));
  mutable int memoryCalls_ = 0;
  mutable std::vector<SeqRmCall> seqRmCalls_;
  mutable std::vector<SeqAddCall> seqAddCalls_;
};
} // namespace

class ContextSliderTest : public ::testing::Test {};

TEST_F(ContextSliderTest, PrefillSlideScenario_EnoughRoom) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/500);

  ContextSlideOutcome outcome = trySlidePrefill(
      /*lctx=*/nullptr,
      /*nPast=*/100,
      /*firstMsgTokens=*/50,
      /*nTokensToAppend=*/50,
      /*nDiscarded=*/100,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::NotNeeded);
  EXPECT_EQ(outcome.newNPast, 100);
  EXPECT_EQ(outcome.discarded, 0);
  EXPECT_EQ(ops.memoryCalls(), 0);
  EXPECT_TRUE(ops.seqRmCalls().empty());
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(ContextSliderTest, PrefillSlidInvokesLlamaOpsWithExpectedRanges) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/400);

  ContextSlideOutcome outcome = trySlidePrefill(
      /*lctx=*/nullptr,
      /*nPast=*/300,
      /*firstMsgTokens=*/50,
      /*nTokensToAppend=*/180,
      /*nDiscarded=*/100,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::Slid);
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

  controller.onTokenize(120, 50);
  controller.onEvalComplete(120, 120);
  EXPECT_EQ(controller.anchor(), 50);

  ContextSlideOutcome outcome = trySlidePrefill(
      /*lctx=*/nullptr,
      /*nPast=*/120,
      /*firstMsgTokens=*/50,
      /*nTokensToAppend=*/200,
      /*nDiscarded=*/100,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::FullWipe);
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

TEST_F(ContextSliderTest, PrefillSlideScenario_Overflow) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/100);

  ContextSlideOutcome outcome = trySlidePrefill(
      /*lctx=*/nullptr,
      /*nPast=*/75,
      /*firstMsgTokens=*/50,
      /*nTokensToAppend=*/200,
      /*nDiscarded=*/100,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::Overflow);
  EXPECT_EQ(outcome.newNPast, 75);
  EXPECT_EQ(outcome.discarded, 0);
  EXPECT_EQ(ops.memoryCalls(), 0);
  EXPECT_TRUE(ops.seqRmCalls().empty());
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(ContextSliderTest, GenerationSlideScenario_EnoughRoom) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/500);

  ContextSlideOutcome outcome = trySlideGeneration(
      /*lctx=*/nullptr,
      /*nPast=*/499,
      /*firstMsgTokens=*/50,
      /*nDiscarded=*/120,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::NotNeeded);
  EXPECT_EQ(outcome.newNPast, 499);
  EXPECT_EQ(outcome.discarded, 0);
  EXPECT_EQ(ops.memoryCalls(), 0);
  EXPECT_TRUE(ops.seqRmCalls().empty());
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(ContextSliderTest, GenerationSlidInvokesLlamaOpsWithExpectedRanges) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/400);

  ContextSlideOutcome outcome = trySlideGeneration(
      /*lctx=*/nullptr,
      /*nPast=*/400,
      /*firstMsgTokens=*/50,
      /*nDiscarded=*/120,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::Slid);
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

TEST_F(ContextSliderTest, GenerationSlideScenario_NoDiscardAllowed) {
  ToolsCompactController controller(std::nullopt);
  FakeLlamaContextOps ops(/*ctxSize=*/500);

  ContextSlideOutcome outcome = trySlideGeneration(
      /*lctx=*/nullptr,
      /*nPast=*/500,
      /*firstMsgTokens=*/50,
      /*nDiscarded=*/0,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::NotNeeded);
  EXPECT_EQ(outcome.newNPast, 500);
  EXPECT_EQ(outcome.discarded, 0);
  EXPECT_EQ(ops.memoryCalls(), 0);
  EXPECT_TRUE(ops.seqRmCalls().empty());
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(ContextSliderTest, GenerationToolsCompactClampsDiscardToAnchorWindow) {
  ToolsCompactController controller(ToolsCompactProfile{});
  FakeLlamaContextOps ops(/*ctxSize=*/140);
  constexpr llama_pos firstMsgTokens = 50;

  controller.onTokenize(/*tokensWithTools=*/140, /*tokensWithoutTools=*/80);
  controller.onEvalComplete(/*nPast=*/140, /*totalTokensEvaled=*/140);
  ASSERT_EQ(controller.anchor(), 80);

  ContextSlideOutcome outcome = trySlideGeneration(
      /*lctx=*/nullptr,
      /*nPast=*/140,
      firstMsgTokens,
      /*nDiscarded=*/120,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::Slid);
  EXPECT_EQ(outcome.newNPast, 110);
  EXPECT_EQ(outcome.discarded, 30);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);

  ASSERT_EQ(ops.memoryCalls(), 1);
  ASSERT_EQ(ops.seqRmCalls().size(), 1u);
  EXPECT_EQ(ops.seqRmCalls()[0].startPos, 50);
  EXPECT_EQ(ops.seqRmCalls()[0].endPos, 80);
  ASSERT_EQ(ops.seqAddCalls().size(), 1u);
  EXPECT_EQ(ops.seqAddCalls()[0].startPos, 80);
  EXPECT_EQ(ops.seqAddCalls()[0].endPos, 140);
  EXPECT_EQ(ops.seqAddCalls()[0].delta, -30);
}

TEST_F(
    ContextSliderTest,
    GenerationDegenerateBoundaryResetsThenSlidesFromFirstMessage) {
  ToolsCompactController controller(ToolsCompactProfile{});
  FakeLlamaContextOps ops(/*ctxSize=*/120);
  constexpr llama_pos firstMsgTokens = 50;

  controller.onTokenize(/*tokensWithTools=*/120, /*tokensWithoutTools=*/50);
  controller.onEvalComplete(/*nPast=*/120, /*totalTokensEvaled=*/120);
  ASSERT_EQ(controller.anchor(), firstMsgTokens);
  ASSERT_TRUE(controller.degenerateBoundary(firstMsgTokens));

  ContextSlideOutcome outcome = trySlideGeneration(
      /*lctx=*/nullptr,
      /*nPast=*/120,
      firstMsgTokens,
      /*nDiscarded=*/40,
      controller,
      ops);

  EXPECT_EQ(outcome.kind, ContextSlideOutcome::Kind::Slid);
  EXPECT_EQ(outcome.newNPast, 80);
  EXPECT_EQ(outcome.discarded, 40);
  EXPECT_EQ(controller.anchor(), firstMsgTokens);

  ASSERT_EQ(ops.memoryCalls(), 1);
  ASSERT_EQ(ops.seqRmCalls().size(), 1u);
  EXPECT_EQ(ops.seqRmCalls()[0].startPos, 50);
  EXPECT_EQ(ops.seqRmCalls()[0].endPos, 90);
  ASSERT_EQ(ops.seqAddCalls().size(), 1u);
  EXPECT_EQ(ops.seqAddCalls()[0].startPos, 90);
  EXPECT_EQ(ops.seqAddCalls()[0].endPos, 120);
  EXPECT_EQ(ops.seqAddCalls()[0].delta, -40);
}

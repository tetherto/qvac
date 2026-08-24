// Covers `compactKvRange`, the KV-cache range primitive used by
// `ReasoningBlockCompactor` to drop a model's reasoning block.

#include <gtest/gtest.h>

#include "model-interface/KvCacheOps.hpp"
#include "test_kv_cache_ops_fake.hpp"

namespace {
constexpr llama_seq_id kSeqId = 7;
using qvac_test::FakeKvCacheOps;
} // namespace

class KvCacheOpsTest : public ::testing::Test {};

TEST_F(KvCacheOpsTest, CompactKvRange_HappyPath_RemovesRangeAndShiftsTail) {
  FakeKvCacheOps ops;
  ops.withResidentTokens(180);

  // Cache layout:  [user prompt 100][reasoning 50][answer 30]
  // We want to drop the reasoning block at [100, 150).
  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/150,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::Compacted);
  EXPECT_EQ(outcome.discarded, 50);
  EXPECT_EQ(outcome.newNPast, 130);

  ASSERT_EQ(ops.seqRmCallLog().size(), 1u);
  EXPECT_EQ(ops.seqRmCallLog()[0].seqId, kSeqId);
  EXPECT_EQ(ops.seqRmCallLog()[0].startPos, 100);
  EXPECT_EQ(ops.seqRmCallLog()[0].endPos, 150);

  // `[150, 180)` shifts down by 50 to land at `[100, 130)`. `p1 = -1` so a
  // cell past the cursor moves with the tail instead of being stranded on it.
  ASSERT_EQ(ops.seqAddCallLog().size(), 1u);
  EXPECT_EQ(ops.seqAddCallLog()[0].seqId, kSeqId);
  EXPECT_EQ(ops.seqAddCallLog()[0].startPos, 150);
  EXPECT_EQ(ops.seqAddCallLog()[0].endPos, -1);
  EXPECT_EQ(ops.seqAddCallLog()[0].delta, -50);
  EXPECT_EQ(ops.seqPosMaxCalls(), 1)
      << "the reported cursor must come from memory, not from arithmetic";
}

TEST_F(KvCacheOpsTest, CompactKvRange_EmptyRange_IsNoOp) {
  FakeKvCacheOps ops;

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/100,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::NoOp);
  EXPECT_EQ(outcome.discarded, 0);
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_EQ(ops.seqRmCalls(), 0);
  EXPECT_EQ(ops.seqAddCalls(), 0);
}

TEST_F(KvCacheOpsTest, CompactKvRange_InvertedRange_IsNoOp) {
  FakeKvCacheOps ops;

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/150,
      /*endPos=*/100,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::NoOp);
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_EQ(ops.seqRmCalls(), 0);
  EXPECT_EQ(ops.seqAddCalls(), 0);
}

TEST_F(KvCacheOpsTest, CompactKvRange_EndPastNPast_IsNoOp) {
  // `end > nPast` means a stale span. Clamping is the caller's job,
  // `ReasoningBlockCompactor::compact` does it with `std::min(recordedEnd,
  // pos)`, so clamping here would hide a caller that didn't.
  FakeKvCacheOps ops;

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/200,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::NoOp);
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_EQ(ops.seqRmCalls(), 0);
  EXPECT_EQ(ops.seqAddCalls(), 0);
}

TEST_F(KvCacheOpsTest, CompactKvRange_NegativeStart_IsNoOp) {
  FakeKvCacheOps ops;

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/-1,
      /*endPos=*/50,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::NoOp);
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_EQ(ops.seqRmCalls(), 0);
}

TEST_F(KvCacheOpsTest, CompactKvRange_NegativeNPast_IsNoOp) {
  // llama's `-1` is "to the end of the sequence", never a cursor. Reaching
  // this as `nPast` would make `endPos > nPast` true for every range and stop
  // compaction silently.
  FakeKvCacheOps ops;

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/150,
      /*nPast=*/-1,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::NoOp);
  EXPECT_EQ(outcome.newNPast, -1);
  EXPECT_EQ(ops.seqRmCalls(), 0);
  EXPECT_EQ(ops.seqAddCalls(), 0);
}

TEST_F(KvCacheOpsTest, CompactKvRange_MemoryCannotShift_RefusesBeforeSeqRm) {
  // `seq_add` GGML_ASSERTs on a module that cannot shift, and `seq_rm` runs
  // first, so that abort would land with the hole already punched.
  FakeKvCacheOps ops;
  ops.denyShift();

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/150,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::MemoryOperationFailed);
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_EQ(outcome.discarded, 0);
  EXPECT_EQ(ops.canShiftCalls(), 1);
  EXPECT_EQ(ops.seqRmCalls(), 0)
      << "a hole must never be opened when the shift that closes it cannot run";
  EXPECT_EQ(ops.seqAddCalls(), 0);
}

TEST_F(KvCacheOpsTest, CompactKvRange_SeqRmFailure_ReportsAndSkipsShift) {
  FakeKvCacheOps ops;
  ops.failSeqRmFor({.seqId = kSeqId, .startPos = 100, .endPos = 150});

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/150,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::MemoryOperationFailed);
  // Caller must not advance bookkeeping on a failed compaction.
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_EQ(outcome.discarded, 0);
  // seqRm was attempted but failed; seqAdd must NOT run, otherwise the
  // cache would be shifted without the corresponding window removed.
  EXPECT_EQ(ops.seqRmCalls(), 1);
  EXPECT_EQ(ops.seqAddCalls(), 0);
}

TEST_F(KvCacheOpsTest, CompactKvRange_TailExactlyAtEnd_NoShiftNeeded) {
  // No tail left to move. `seqAdd` still runs over an empty set of cells,
  // which keeps the primitive's two halves paired.
  FakeKvCacheOps ops;
  ops.withResidentTokens(180);

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/180,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::Compacted);
  EXPECT_EQ(outcome.discarded, 80);
  EXPECT_EQ(outcome.newNPast, 100);
  EXPECT_EQ(ops.seqRmCalls(), 1);
  ASSERT_EQ(ops.seqAddCallLog().size(), 1u);
  EXPECT_EQ(ops.seqAddCallLog()[0].startPos, 180);
  EXPECT_EQ(ops.seqAddCallLog()[0].endPos, -1);
  EXPECT_EQ(ops.seqAddCallLog()[0].delta, -80);
}

TEST_F(KvCacheOpsTest, CompactKvRange_ShiftDidNotLand_ReportsMemoryFailure) {
  // The cells can fail to move while `seq_rm` still reports success: a
  // shared-cells module no-ops both halves, and a drifted cursor shifts
  // elsewhere. `Compacted` there would have the driver write a cache header
  // describing memory that does not exist.
  FakeKvCacheOps ops;
  ops.withResidentTokens(180).ignoreSeqRmEffect();

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/150,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::MemoryInconsistent)
      << "the removal already ran, so this is not the all-or-nothing "
         "rejection: reporting MemoryOperationFailed here would tell the "
         "caller its cache is intact when a hole has been punched in it";
  EXPECT_EQ(outcome.newNPast, 180)
      << "report the cursor memory actually has, which here is the "
         "unshifted one the fake still models";
  EXPECT_EQ(outcome.discarded, 0);
  EXPECT_EQ(ops.seqPosMaxCalls(), 1);
}

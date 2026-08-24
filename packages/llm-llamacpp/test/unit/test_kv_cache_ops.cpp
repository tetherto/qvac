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

  // The surviving tail from 150 on shifts down by 50, so `[150, 180)` lands
  // at `[100, 130)`. `p1 = -1` is llama's "to the end of the sequence", so a
  // cell that somehow sits past the cursor moves with the tail instead of
  // being stranded on top of it.
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
  // Defensive: end > nPast means the recorded span is stale. Refuse to
  // compact rather than corrupt the cache. Clamping the span to the live
  // cursor is the caller's job (`ReasoningBlockCompactor::compact` does it
  // with `std::min(recordedEnd, pos)`); this primitive owns no policy, so a
  // silent clamp here would hide the caller's inconsistency.
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
  // llama uses `-1` for "to the end of the sequence", never as a cursor. If it
  // ever reached this primitive as `nPast`, the `endPos > nPast` guard would
  // be true for every range and compaction would silently stop happening.
  // Reject it outright instead.
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
  // `llama_memory_seq_add` GGML_ASSERTs on a module that cannot shift, which
  // aborts the process. Since `seq_rm` runs first, that abort would land after
  // the hole was already punched. Refuse up front so the cache is never left
  // with a hole nothing can close.
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
  // Range covers everything from `startPos` to `nPast`, so there is no tail
  // left to move. `seqAdd` still runs: it walks an empty set of cells, which
  // is cheap, and keeping the call unconditional keeps the primitive's two
  // halves paired.
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
  // `seq_add` is void, and there are ways for the cells not to move while
  // `seq_rm` still reports success: a memory module sharing cells with another
  // no-ops both halves, and a software cursor that has drifted from live
  // memory gets a shift that lands somewhere else. Returning `Compacted` there
  // hands the driver a cursor no live cell backs, and the driver then writes a
  // cache header describing memory that does not exist. The readback is what
  // separates the two, so it must reject rather than trust the arithmetic.
  FakeKvCacheOps ops;
  ops.withResidentTokens(180).ignoreSeqRmEffect();

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/150,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::MemoryOperationFailed);
  EXPECT_EQ(outcome.newNPast, 180)
      << "a failed compaction must leave the caller's cursor alone";
  EXPECT_EQ(outcome.discarded, 0);
  EXPECT_EQ(ops.seqPosMaxCalls(), 1);
}

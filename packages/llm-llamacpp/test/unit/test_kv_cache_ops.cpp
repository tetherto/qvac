// Covers `compactKvRange`, the KV-cache range primitive used by
// `ReasoningBlockCompactor` to drop a model's reasoning block.

#include <cstdint>
#include <optional>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/KvCacheOps.hpp"

namespace {
constexpr llama_seq_id kSeqId = 7;

struct SeqRmCall {
  llama_seq_id seqId = 0;
  llama_pos startPos = 0;
  llama_pos endPos = 0;
};

bool operator==(const SeqRmCall& lhs, const SeqRmCall& rhs) {
  return lhs.seqId == rhs.seqId && lhs.startPos == rhs.startPos &&
         lhs.endPos == rhs.endPos;
}

struct SeqAddCall {
  llama_seq_id seqId = 0;
  llama_pos startPos = 0;
  llama_pos endPos = 0;
  llama_pos delta = 0;
};

bool operator==(const SeqAddCall& lhs, const SeqAddCall& rhs) {
  return lhs.seqId == rhs.seqId && lhs.startPos == rhs.startPos &&
         lhs.endPos == rhs.endPos && lhs.delta == rhs.delta;
}

class FakeLlamaContextOps final : public IKvCacheOps {
public:
  KvCacheMemoryHandle memory(llama_context*) const override {
    ++memoryCalls_;
    return fakeMemory_;
  }

  bool seqRm(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const override {
    EXPECT_EQ(mem, fakeMemory_);
    seqRmCalls_.push_back({seqId, startPos, endPos});

    if (seqRmFailure_ && seqRmFailure_->seqId == seqId &&
        seqRmFailure_->startPos == startPos &&
        seqRmFailure_->endPos == endPos) {
      return false;
    }

    return true;
  }

  void seqAdd(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const override {
    EXPECT_EQ(mem, fakeMemory_);
    seqAddCalls_.push_back({seqId, startPos, endPos, delta});
  }

  int memoryCalls() const { return memoryCalls_; }
  const std::vector<SeqRmCall>& seqRmCalls() const { return seqRmCalls_; }
  const std::vector<SeqAddCall>& seqAddCalls() const { return seqAddCalls_; }
  void failSeqRmFor(SeqRmCall call) { seqRmFailure_ = call; }

private:
  KvCacheMemoryHandle fakeMemory_ =
      reinterpret_cast<KvCacheMemoryHandle>(static_cast<uintptr_t>(0x1));
  mutable int memoryCalls_ = 0;
  mutable std::vector<SeqRmCall> seqRmCalls_;
  mutable std::vector<SeqAddCall> seqAddCalls_;
  std::optional<SeqRmCall> seqRmFailure_;
};
} // namespace

class KvCacheOpsTest : public ::testing::Test {};

TEST_F(KvCacheOpsTest, CompactKvRange_HappyPath_RemovesRangeAndShiftsTail) {
  FakeLlamaContextOps ops;

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

  ASSERT_EQ(ops.seqRmCalls().size(), 1u);
  EXPECT_EQ(ops.seqRmCalls()[0].seqId, kSeqId);
  EXPECT_EQ(ops.seqRmCalls()[0].startPos, 100);
  EXPECT_EQ(ops.seqRmCalls()[0].endPos, 150);

  // The surviving tail `[150, 180)` should shift down by 50 to occupy
  // `[100, 130)`.
  ASSERT_EQ(ops.seqAddCalls().size(), 1u);
  EXPECT_EQ(ops.seqAddCalls()[0].seqId, kSeqId);
  EXPECT_EQ(ops.seqAddCalls()[0].startPos, 150);
  EXPECT_EQ(ops.seqAddCalls()[0].endPos, 180);
  EXPECT_EQ(ops.seqAddCalls()[0].delta, -50);
}

TEST_F(KvCacheOpsTest, CompactKvRange_EmptyRange_IsNoOp) {
  FakeLlamaContextOps ops;

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
  EXPECT_TRUE(ops.seqRmCalls().empty());
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(KvCacheOpsTest, CompactKvRange_InvertedRange_IsNoOp) {
  FakeLlamaContextOps ops;

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/150,
      /*endPos=*/100,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::NoOp);
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_TRUE(ops.seqRmCalls().empty());
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(KvCacheOpsTest, CompactKvRange_EndPastNPast_IsNoOp) {
  // Defensive: end > nPast means the recorded span is stale. Refuse to
  // compact rather than corrupt the cache.
  FakeLlamaContextOps ops;

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/100,
      /*endPos=*/200,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::NoOp);
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_TRUE(ops.seqRmCalls().empty());
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(KvCacheOpsTest, CompactKvRange_NegativeStart_IsNoOp) {
  FakeLlamaContextOps ops;

  const auto outcome = compactKvRange(
      /*lctx=*/nullptr,
      kSeqId,
      /*startPos=*/-1,
      /*endPos=*/50,
      /*nPast=*/180,
      ops);

  EXPECT_EQ(outcome.kind, CompactRangeOutcome::Kind::NoOp);
  EXPECT_EQ(outcome.newNPast, 180);
  EXPECT_TRUE(ops.seqRmCalls().empty());
}

TEST_F(KvCacheOpsTest, CompactKvRange_SeqRmFailure_ReportsAndSkipsShift) {
  FakeLlamaContextOps ops;
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
  ASSERT_EQ(ops.seqRmCalls().size(), 1u);
  EXPECT_TRUE(ops.seqAddCalls().empty());
}

TEST_F(KvCacheOpsTest, CompactKvRange_TailExactlyAtEnd_NoShiftNeeded) {
  // Range covers everything from `startPos` to `nPast`. The shift is a
  // no-op range `[end, end)` for `seqAdd`, but we still expect it to be
  // invoked (`seqAdd` with start==end is a cheap no-op for llama).
  FakeLlamaContextOps ops;

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
  ASSERT_EQ(ops.seqRmCalls().size(), 1u);
  ASSERT_EQ(ops.seqAddCalls().size(), 1u);
  EXPECT_EQ(ops.seqAddCalls()[0].startPos, 180);
  EXPECT_EQ(ops.seqAddCalls()[0].endPos, 180);
  EXPECT_EQ(ops.seqAddCalls()[0].delta, -80);
}

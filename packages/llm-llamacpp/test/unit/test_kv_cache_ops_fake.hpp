#pragma once

// One configurable `IKvCacheOps` fake for every unit test that drives
// `compactKvRange` without a real llama context. Replaces the three
// near-identical fakes that used to live in `test_kv_cache_ops.cpp`,
// `test_cancel_rollback.cpp` and `test_reasoning_block_compactor.cpp`.
//
// Defaults accept everything. The knobs drive the other halves of the
// contract: `rejectSeqRm`, `failSeqRmFor`, `denyShift`, `forwardRealMemory`
// (hand back the live handle so `clearSeqOnFailure` works), and
// `ignoreSeqRmEffect` (succeed but leave the modelled cells put, which is how
// a shared-cells module and a drifted cursor both look from here).
//
// `withResidentTokens` models a sequence holding `[0, n)` and has no default
// on purpose: `seqPosMax` fails the test without it, so a readback assertion
// can never quietly become a rubber stamp on the primitive's own arithmetic.

#include <cstdint>
#include <optional>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/KvCacheOps.hpp"

namespace qvac_test {

struct SeqRmCall {
  llama_seq_id seqId = 0;
  llama_pos startPos = 0;
  llama_pos endPos = 0;
};

inline bool operator==(const SeqRmCall& lhs, const SeqRmCall& rhs) {
  return lhs.seqId == rhs.seqId && lhs.startPos == rhs.startPos &&
         lhs.endPos == rhs.endPos;
}

struct SeqAddCall {
  llama_seq_id seqId = 0;
  llama_pos startPos = 0;
  llama_pos endPos = 0;
  llama_pos delta = 0;
};

inline bool operator==(const SeqAddCall& lhs, const SeqAddCall& rhs) {
  return lhs.seqId == rhs.seqId && lhs.startPos == rhs.startPos &&
         lhs.endPos == rhs.endPos && lhs.delta == rhs.delta;
}

class FakeKvCacheOps final : public IKvCacheOps {
public:
  KvCacheMemoryHandle memory(llama_context* lctx) const override {
    ++memoryCalls_;
    return forwardRealMemory_ ? llama_get_memory(lctx) : fakeMemory_;
  }

  bool canShift(KvCacheMemoryHandle mem) const override {
    expectMemory(mem);
    ++canShiftCalls_;
    return canShift_;
  }

  bool seqRm(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const override {
    expectMemory(mem);
    seqRmCalls_.push_back({seqId, startPos, endPos});

    if (rejectAllSeqRm_) {
      return false;
    }
    const SeqRmCall call{seqId, startPos, endPos};
    if (seqRmFailure_ && *seqRmFailure_ == call) {
      return false;
    }
    if (residentTokens_ && !ignoreSeqRmEffect_) {
      const llama_pos width = endPos - startPos;
      *residentTokens_ =
          width < *residentTokens_ ? *residentTokens_ - width : 0;
    }
    return true;
  }

  void seqAdd(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const override {
    expectMemory(mem);
    seqAddCalls_.push_back({seqId, startPos, endPos, delta});
  }

  llama_pos seqPosMax(KvCacheMemoryHandle mem, llama_seq_id) const override {
    expectMemory(mem);
    ++seqPosMaxCalls_;
    if (!residentTokens_) {
      ADD_FAILURE() << "compactKvRange read back seq_pos_max but this fake has "
                       "no modelled sequence; call withResidentTokens(nPast) "
                       "so the readback is a real check";
      return -1;
    }
    // llama reports -1 for an empty sequence, and so must this.
    return *residentTokens_ - 1;
  }

  // ---- Configuration ----
  FakeKvCacheOps& rejectSeqRm() {
    rejectAllSeqRm_ = true;
    return *this;
  }
  FakeKvCacheOps& failSeqRmFor(SeqRmCall call) {
    seqRmFailure_ = call;
    return *this;
  }
  FakeKvCacheOps& denyShift() {
    canShift_ = false;
    return *this;
  }
  FakeKvCacheOps& forwardRealMemory() {
    forwardRealMemory_ = true;
    return *this;
  }
  /// Model a sequence holding positions `[0, tokens)`.
  FakeKvCacheOps& withResidentTokens(llama_pos tokens) {
    residentTokens_ = tokens;
    return *this;
  }
  /// `seqRm` succeeds but the modelled cells stay put, which is how a
  /// shared-cells module and a drifted cursor both look from here.
  FakeKvCacheOps& ignoreSeqRmEffect() {
    ignoreSeqRmEffect_ = true;
    return *this;
  }

  // ---- Observation ----
  int memoryCalls() const { return memoryCalls_; }
  int canShiftCalls() const { return canShiftCalls_; }
  int seqPosMaxCalls() const { return seqPosMaxCalls_; }
  int seqRmCalls() const { return static_cast<int>(seqRmCalls_.size()); }
  int seqAddCalls() const { return static_cast<int>(seqAddCalls_.size()); }
  const std::vector<SeqRmCall>& seqRmCallLog() const { return seqRmCalls_; }
  const std::vector<SeqAddCall>& seqAddCallLog() const { return seqAddCalls_; }

private:
  void expectMemory(KvCacheMemoryHandle mem) const {
    if (!forwardRealMemory_) {
      EXPECT_EQ(mem, fakeMemory_);
    }
  }

  KvCacheMemoryHandle fakeMemory_ =
      reinterpret_cast<KvCacheMemoryHandle>(static_cast<uintptr_t>(0x1));
  bool canShift_ = true;
  bool rejectAllSeqRm_ = false;
  bool forwardRealMemory_ = false;
  bool ignoreSeqRmEffect_ = false;
  std::optional<SeqRmCall> seqRmFailure_;
  mutable std::optional<llama_pos> residentTokens_;
  mutable int memoryCalls_ = 0;
  mutable int canShiftCalls_ = 0;
  mutable int seqPosMaxCalls_ = 0;
  mutable std::vector<SeqRmCall> seqRmCalls_;
  mutable std::vector<SeqAddCall> seqAddCalls_;
};

} // namespace qvac_test

#pragma once

// One configurable `IKvCacheOps` fake for every unit test that drives
// `compactKvRange` without a real llama context. It replaces the three
// near-identical fakes that used to live in `test_kv_cache_ops.cpp`,
// `test_cancel_rollback.cpp` and `test_reasoning_block_compactor.cpp`;
// adding a method to the interface only has to be answered here.
//
// Defaults accept everything, which is the successful-drop case. Tests that
// need the other half of the contract flip one knob:
//
//   * `rejectSeqRm()`            — every `seqRm` returns false. The primitive
//                                  is all-or-nothing on rejection, so
//                                  `seqAdd` must not fire afterwards.
//   * `failSeqRmFor(call)`       — reject one exact range, accept the rest.
//   * `denyShift()`              — the memory module cannot shift, so the
//                                  primitive must refuse before `seqRm`.
//   * `forwardRealMemory()`      — return the live handle from
//                                  `llama_get_memory` instead of a sentinel,
//                                  for tests that also exercise the
//                                  compactor's own `clearSeqOnFailure`.

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
    return !(seqRmFailure_ && *seqRmFailure_ == call);
  }

  void seqAdd(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const override {
    expectMemory(mem);
    seqAddCalls_.push_back({seqId, startPos, endPos, delta});
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

  // ---- Observation ----
  int memoryCalls() const { return memoryCalls_; }
  int canShiftCalls() const { return canShiftCalls_; }
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
  std::optional<SeqRmCall> seqRmFailure_;
  mutable int memoryCalls_ = 0;
  mutable int canShiftCalls_ = 0;
  mutable std::vector<SeqRmCall> seqRmCalls_;
  mutable std::vector<SeqAddCall> seqAddCalls_;
};

} // namespace qvac_test

#include "KvCacheOps.hpp"

#include "common/common.h"

namespace {
class KvCacheOps final : public IKvCacheOps {
public:
  KvCacheMemoryHandle memory(llama_context* lctx) const override {
    return llama_get_memory(lctx);
  }

  bool canShift(KvCacheMemoryHandle mem) const override {
    return llama_memory_can_shift(mem);
  }

  bool seqRm(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const override {
    return llama_memory_seq_rm(mem, seqId, startPos, endPos);
  }

  void seqAdd(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const override {
    llama_memory_seq_add(mem, seqId, startPos, endPos, delta);
  }

  llama_pos
  seqPosMax(KvCacheMemoryHandle mem, llama_seq_id seqId) const override {
    return llama_memory_seq_pos_max(mem, seqId);
  }
};
} // namespace

const IKvCacheOps& defaultKvCacheOps() {
  static const KvCacheOps ops;
  return ops;
}

CompactRangeOutcome compactKvRange(
    llama_context* lctx, llama_seq_id seqId, llama_pos startPos,
    llama_pos endPos, llama_pos nPast, const IKvCacheOps& ops) {
  // `nPast < 0` is llama's "to the end of the sequence" sentinel, not a
  // cursor: accepting it would make `endPos > nPast` true for every range and
  // silently skip compaction. `endPos > nPast` stays a refusal rather than a
  // clamp, since the compactor already clamps and hiding a caller that did not
  // would be worse.
  if (nPast < 0 || endPos <= startPos || startPos < 0 || endPos > nPast) {
    return {CompactRangeOutcome::Kind::NoOp, nPast, 0};
  }

  const llama_pos discarded = endPos - startPos;
  auto mem = ops.memory(lctx);
  // `seq_add` `GGML_ASSERT`s when the module cannot shift (Step35, or an
  // M-RoPE layout the K-shift graph does not cover). That abort would land
  // after `seq_rm` had opened the hole, so refuse up front.
  if (!ops.canShift(mem)) {
    return {CompactRangeOutcome::Kind::MemoryOperationFailed, nPast, 0};
  }
  if (!ops.seqRm(mem, seqId, startPos, endPos)) {
    return {CompactRangeOutcome::Kind::MemoryOperationFailed, nPast, 0};
  }
  // `p1 = -1` is "to the end of the sequence", matching llama's own slide
  // callers. `nPast` would strand any cell past the cursor at a position the
  // shifted tail now also occupies.
  ops.seqAdd(mem, seqId, endPos, /*p1=*/-1, -discarded);

  // `seq_add` is void, and it can leave the cells where they are while
  // `seq_rm` still reported success: a module sharing cells
  // (`TAG_KV_CACHE_SHARE_CELLS`) no-ops both halves, and a drifted software
  // cursor gets a shift that lands elsewhere. Trusting the arithmetic there
  // saves a cache header describing memory that does not exist, so take the
  // cursor from memory. `seq_pos_max` is -1 on an empty sequence, which is the
  // right answer when the whole span went.
  const llama_pos expectedNPast = nPast - discarded;
  const llama_pos observedNPast = ops.seqPosMax(mem, seqId) + 1;
  if (observedNPast != expectedNPast) {
    // `seqRm` already ran, so this is not the all-or-nothing rejection above:
    // the hole is in the middle and a tail trim cannot reach it. Report the
    // cursor memory actually has rather than either guess.
    return {CompactRangeOutcome::Kind::MemoryInconsistent, observedNPast, 0};
  }
  return {CompactRangeOutcome::Kind::Compacted, expectedNPast, discarded};
}

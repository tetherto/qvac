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
  // silently skip compaction. A range that runs past the cursor is a caller
  // bug, not something to clamp here — the compactor clamps its span to the
  // live cursor before it calls in, and a silent clamp in a primitive that
  // owns no policy would hide the caller's inconsistency.
  if (nPast < 0 || endPos <= startPos || startPos < 0 || endPos > nPast) {
    return {CompactRangeOutcome::Kind::NoOp, nPast, 0};
  }

  const llama_pos discarded = endPos - startPos;
  auto mem = ops.memory(lctx);
  // `seq_add` `GGML_ASSERT`s when the memory module cannot shift (Step35,
  // or an M-RoPE layout the K-shift graph does not cover), which would abort
  // the process after `seq_rm` had already opened the hole. Refuse up front so
  // the cache is never left with a hole nothing can close.
  if (!ops.canShift(mem)) {
    return {CompactRangeOutcome::Kind::MemoryOperationFailed, nPast, 0};
  }
  if (!ops.seqRm(mem, seqId, startPos, endPos)) {
    return {CompactRangeOutcome::Kind::MemoryOperationFailed, nPast, 0};
  }
  // `p1 = -1` means "to the end of the sequence", matching llama's own slide
  // callers. Passing `nPast` instead would strand any cell that sits past the
  // cursor, leaving it at a position the shifted tail now also occupies.
  ops.seqAdd(mem, seqId, endPos, /*p1=*/-1, -discarded);

  // Take the new cursor from memory rather than from arithmetic on the one we
  // were handed. `seq_add` is void, and there are ways for it to leave the
  // cells where they were while `seq_rm` still reported success: a memory
  // module sharing cells with another (`TAG_KV_CACHE_SHARE_CELLS`) no-ops both
  // halves, and a caller whose software cursor has drifted from live memory
  // gets a shift that lands somewhere else. Either way the arithmetic answer
  // would be a cursor no live cell backs, and the driver would save a cache
  // header describing memory that does not exist. `seq_pos_max` returns -1 on
  // an empty sequence, which is the correct readback when the whole span went.
  const llama_pos expectedNPast = nPast - discarded;
  const llama_pos observedNPast = ops.seqPosMax(mem, seqId) + 1;
  if (observedNPast != expectedNPast) {
    return {CompactRangeOutcome::Kind::MemoryOperationFailed, nPast, 0};
  }
  return {CompactRangeOutcome::Kind::Compacted, expectedNPast, discarded};
}

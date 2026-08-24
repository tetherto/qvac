#pragma once

#include <llama.h>

using KvCacheMemoryHandle =
    decltype(llama_get_memory(static_cast<llama_context*>(nullptr)));

/// Small indirection layer around llama context/memory operations.
///
/// This makes KV-cache range edits testable without a real llama_context.
struct IKvCacheOps {
  virtual ~IKvCacheOps() = default;
  virtual KvCacheMemoryHandle memory(llama_context* lctx) const = 0;
  /// `seq_add` `GGML_ASSERT`s on a module that cannot shift, so this must be
  /// checked before the `seq_rm` that opens the hole the shift would close.
  virtual bool canShift(KvCacheMemoryHandle mem) const = 0;
  virtual bool seqRm(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const = 0;
  virtual void seqAdd(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const = 0;
  /// Largest live position for `seqId`, or -1 when the sequence is empty.
  /// Read back after the shift so the reported cursor comes from memory
  /// rather than from arithmetic on a cursor we were handed.
  virtual llama_pos
  seqPosMax(KvCacheMemoryHandle mem, llama_seq_id seqId) const = 0;
};

/// Returns the default llama-backed ops implementation.
const IKvCacheOps& defaultKvCacheOps();

/// Outcome of an in-place KV-cache range compaction.
struct CompactRangeOutcome {
  enum class Kind {
    NoOp,      // Empty / inverted range; cache untouched
    Compacted, // Range removed and tail shifted, confirmed against memory
    // Refused before anything was written, so the caller can unwind its tail.
    MemoryOperationFailed,
    // The removal ran and the shift did not, so the hole is in the middle and
    // its extent is unknowable from here. Only a wipe recovers this.
    MemoryInconsistent,
  };

  Kind kind = Kind::NoOp;
  llama_pos newNPast = 0;
  llama_pos discarded = 0;
};

/// Drops `[startPos, endPos)` from `seqId`'s KV cache and shifts the tail
/// down. Pure primitive; the caller owns policy.
///
/// Returns `NoOp` without touching the cache for an empty or inverted range,
/// a negative `startPos`, or a negative `nPast` (llama uses `-1` as its
/// "to the end of the sequence" sentinel, which is not a cursor).
///
/// Returns `MemoryOperationFailed` when the module cannot shift or `seqRm`
/// rejects the range, both before any write.
///
/// Returns `MemoryInconsistent` when the post-shift `seq_pos_max` readback
/// disagrees with `nPast - discarded`, which catches a `seqRm` that reported
/// success while the paired shift silently did nothing. Kept separate because
/// the removal has already run by then and the two need different recovery.
CompactRangeOutcome compactKvRange(
    llama_context* lctx, llama_seq_id seqId, llama_pos startPos,
    llama_pos endPos, llama_pos nPast,
    const IKvCacheOps& ops = defaultKvCacheOps());

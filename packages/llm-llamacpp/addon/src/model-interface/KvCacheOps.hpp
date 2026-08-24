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
  /// Whether this memory module can rewrite cell positions. `seq_add`
  /// `GGML_ASSERT`s on a module that cannot, so this must be checked before
  /// the `seq_rm` that opens the hole the shift is meant to close.
  virtual bool canShift(KvCacheMemoryHandle mem) const = 0;
  virtual bool seqRm(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const = 0;
  virtual void seqAdd(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const = 0;
  /// Largest position live in the memory for `seqId`, or -1 when the sequence
  /// is empty. Read back after the shift so the reported cursor comes from
  /// memory rather than from arithmetic on a cursor we were handed.
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
    // Cannot shift, seqRm rejected the request, or the shift did not land
    // where the arithmetic said it would.
    MemoryOperationFailed,
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
/// Returns `MemoryOperationFailed` when the memory module cannot shift, so a
/// hole is never punched that the shift cannot close; when `seqRm` itself
/// rejects the range; and when the post-shift `seq_pos_max` readback does not
/// agree with `nPast - discarded`. The last one is what catches a `seq_rm`
/// that reported success while the paired shift silently did nothing, which
/// would otherwise return `Compacted` with a cursor no live cell backs.
CompactRangeOutcome compactKvRange(
    llama_context* lctx, llama_seq_id seqId, llama_pos startPos,
    llama_pos endPos, llama_pos nPast,
    const IKvCacheOps& ops = defaultKvCacheOps());

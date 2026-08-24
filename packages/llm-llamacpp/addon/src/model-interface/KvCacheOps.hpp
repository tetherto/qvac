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
  virtual bool seqRm(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const = 0;
  virtual void seqAdd(
      KvCacheMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const = 0;
};

/// Returns the default llama-backed ops implementation.
const IKvCacheOps& defaultKvCacheOps();

/// Outcome of an in-place KV-cache range compaction.
struct CompactRangeOutcome {
  enum class Kind {
    NoOp,                  // Empty / inverted range; cache untouched
    Compacted,             // Range removed and tail shifted
    MemoryOperationFailed, // seqRm rejected the request
  };

  Kind kind = Kind::NoOp;
  llama_pos newNPast = 0;
  llama_pos discarded = 0;
};

/// Drops `[startPos, endPos)` from `seqId`'s KV cache and shifts the tail
/// `[endPos, nPast)` down. Pure primitive; the caller owns policy.
/// Returns NoOp for empty / out-of-range inputs without touching the cache.
CompactRangeOutcome compactKvRange(
    llama_context* lctx, llama_seq_id seqId, llama_pos startPos,
    llama_pos endPos, llama_pos nPast,
    const IKvCacheOps& ops = defaultKvCacheOps());

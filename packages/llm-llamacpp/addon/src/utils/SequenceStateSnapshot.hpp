#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <llama.h>

namespace qvac_lib_inference_addon_llama {
namespace utils {

// Owning handle for a per-sequence full-state snapshot. Captured through
// llama.cpp's full-state sequence path (`state_seq_write_data`), either to a
// temp file via `llama_state_seq_save_file` or to a host buffer via
// `llama_state_seq_get_data`.
//
// The snapshot is model-agnostic: it captures whatever memory llama.cpp
// keeps for `seqId`. It is required wherever that memory cannot be
// rewound by removing a tail range (see `needsFullStateSnapshot` in
// ModelMemoryPolicy.hpp): recurrent (SSM / RWKV) and hybrid models,
// whose hidden state is not positionally indexed, and DeepSeek V4,
// whose compressed cache has the same restriction. On hybrid memories
// the dump covers BOTH the attention KV and the recurrent hidden state,
// so a later `llama_state_seq_load_file` rebuilds the entire sequence
// in one shot without needing `seq_rm` (which the recurrent module
// rejects for partial-tail ranges that include the final committed pos).
//
// Two backends, chosen per model load (`cache_checkpoint_storage`):
//   * Disk (default): the state goes to a temp file that is RAII-removed on
//     clear / destruct / move-out. The object holds only the path.
//   * Memory: the state stays in a host byte buffer produced by
//     `llama_state_seq_get_data`. Nothing touches the disk, at the cost of one
//     full copy of the sequence state in RAM per live snapshot.
// Both hold the same bytes; `bytes()` reports the payload size either way so
// a byte budget can be enforced across checkpoints.
//
// Move-only: the payload is owned by this object. Copying would either alias
// the path (double delete) or duplicate the payload (slow, wasteful). Moves
// transfer ownership and leave the source in an empty state.
//
// `nPast` records the next-position-to-write at snapshot time.
//
// Two scopes:
//   * Full: the whole sequence, attention KV included. Restore replaces it.
//   * Partial: only the parts of the memory a tail trim cannot rewind
//     (`LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY`: the recurrent state of a hybrid
//     or recurrent model, the window of a sliding-window cache). Its size
//     does not grow with the context. Restore puts that part back and trims
//     the attention KV to `nPast`, so it is only valid while the attention KV
//     still holds the sequence's first `nPast` positions unchanged, as it
//     does for a rollback or for a checkpoint whose ledger is a prefix of the
//     resident one.
enum class SnapshotStorage { Disk, Memory };
enum class SnapshotScope { Full, Partial };

class SequenceStateSnapshot {
public:
  SequenceStateSnapshot() = default;
  ~SequenceStateSnapshot();

  SequenceStateSnapshot(const SequenceStateSnapshot&) = delete;
  SequenceStateSnapshot& operator=(const SequenceStateSnapshot&) = delete;
  SequenceStateSnapshot(SequenceStateSnapshot&& other) noexcept;
  SequenceStateSnapshot& operator=(SequenceStateSnapshot&& other) noexcept;

  // `nPast` is intentionally a public field — it mirrors the caller's
  // sequence cursor at snapshot time and is read/written together with
  // `empty()` / `filePath()` by the rollback machinery.
  llama_pos nPast = 0;

  // A snapshot is "empty" only when no capture has been recorded yet.
  // A successful capture at `nPastAt <= 0` records an empty-sequence
  // snapshot (`captured_ == true`, `filePath_.empty()`); restoring it
  // clears the live sequence so the recurrent / hybrid memory rewinds
  // to the same pre-decode state the in-memory variant produced.
  [[nodiscard]] bool empty() const noexcept { return !captured_; }
  [[nodiscard]] const std::string& filePath() const noexcept {
    return filePath_;
  }
  // True when the snapshot owns an on-disk payload. False for a
  // captured-but-empty snapshot (anchor for "rewind sequence to
  // empty" on restore) and for a memory-backed one.
  [[nodiscard]] bool hasFile() const noexcept { return !filePath_.empty(); }
  // True when the snapshot owns an in-memory payload.
  [[nodiscard]] bool hasBuffer() const noexcept { return !buffer_.empty(); }
  // True when there is a payload to restore from, on disk or in memory.
  [[nodiscard]] bool hasPayload() const noexcept {
    return hasFile() || hasBuffer();
  }
  // Payload size in bytes (file or buffer); 0 for a captured-empty snapshot.
  [[nodiscard]] uint64_t bytes() const noexcept { return bytes_; }
  [[nodiscard]] const std::vector<uint8_t>& buffer() const noexcept {
    return buffer_;
  }
  [[nodiscard]] SnapshotScope scope() const noexcept { return scope_; }
  void setScope(SnapshotScope scope) noexcept { scope_ = scope; }

  // Best-effort cleanup. Removes the underlying file (if any) and
  // resets `nPast` / `captured_`. Safe to call multiple times, safe on
  // a snapshot that never adopted a file.
  void clear() noexcept;

  // Test seam. Adopts a path without going through
  // `llama_state_seq_save_file`, so unit tests can exercise the
  // `empty()` gates without loading a real
  // `llama_context`. The path does not have to exist on disk —
  // production code MUST use `snapshotSequenceState` instead so the
  // payload is actually valid for restore.
  void seedForTesting(std::string filePath, llama_pos nPastAt) noexcept;

  // Test seam. Marks the snapshot captured at `nPastAt` with no
  // backing file, mirroring the empty-sequence capture path. Lets
  // unit tests assert the captured-empty restore branch without
  // standing up a real `llama_context`.
  void seedEmptyForTesting(llama_pos nPastAt) noexcept;

  // Transfer ownership of a temp file produced by
  // `llama_state_seq_save_file` into this snapshot. Removes any
  // previously owned payload. Used by `snapshotSequenceState`; not
  // intended for general callers. `bytes` is the file's payload size.
  void
  adoptFile(std::string filePath, llama_pos nPastAt, uint64_t bytes) noexcept;

  // Take ownership of an in-memory payload produced by
  // `llama_state_seq_get_data`. Removes any previously owned payload.
  void adoptBuffer(std::vector<uint8_t> buffer, llama_pos nPastAt) noexcept;

  // Mark this snapshot as a successful capture of an empty sequence
  // (no on-disk payload). Restore behaviour for this state is "clear
  // the sequence's memory" — equivalent to the legacy in-memory
  // `set_data_ext` on the empty-state serialization.
  void adoptEmpty(llama_pos nPastAt) noexcept;

private:
  std::string filePath_;
  std::vector<uint8_t> buffer_;
  uint64_t bytes_ = 0;
  bool captured_ = false;
  SnapshotScope scope_ = SnapshotScope::Full;
};

// Captures the state of `seqId` into `out`, recording `nPastAt` alongside it.
// With `SnapshotStorage::Disk` the state is written to a fresh per-process
// unique temp file; with `SnapshotStorage::Memory` it is copied into a host
// buffer and the disk is never touched. `scope` picks the full sequence or
// only its non-trimmable part (see `SnapshotScope`).
//
// Returns true on success. Returns false when llama.cpp reports a 0-byte
// write/copy — `out` is cleared (and any partial file removed) so a later
// restore cannot accidentally read a half-written payload.
//
// Empty sequences (`nPastAt <= 0`) are treated as a successful capture with
// no payload (see `adoptEmpty`); `out.empty()` returns false afterwards so the
// rollback gates know a capture has been recorded, and `restoreSequenceState`
// will clear the sequence memory to match.
bool snapshotSequenceState(
    ::llama_context* lctx, llama_seq_id seqId, llama_pos nPastAt,
    SequenceStateSnapshot& out, SnapshotStorage storage = SnapshotStorage::Disk,
    SnapshotScope scope = SnapshotScope::Full);

// Upper bound, in bytes, of one snapshot of `seqId`-style state once a
// sequence holds `perSeqTokens` tokens. Measured, not modelled: decodes two
// probe tokens into sequence 0 of an otherwise idle context, reads the state
// size after each, derives the fixed part (recurrent state, headers) and the
// per-token part (KV cells), then clears sequence 0 again and resets the
// perf counters. Works for any memory layout. Returns 0 when the probe cannot
// run (null context, decode failure); callers then skip budget validation.
// Must only be called while no request is in flight. With
// `SnapshotScope::Partial` the per-token part is zero on hybrid and recurrent
// memory, so the bound is the fixed recurrent state.
[[nodiscard]] uint64_t estimateMaxSequenceStateBytes(
    ::llama_context* lctx, const ::llama_vocab* vocab, uint32_t perSeqTokens,
    SnapshotScope scope = SnapshotScope::Full);

// Process-wide count of snapshot files actually written by
// `snapshotSequenceState` (empty-sequence captures write nothing and are not
// counted). Test seam: lets a test prove a code path never touched the disk.
[[nodiscard]] uint64_t sequenceStateSnapshotFilesWritten() noexcept;

// Restores `snapshot` into `seqId`. A full snapshot backed by a file goes
// through `llama_state_seq_load_file`, a memory-backed one through
// `llama_state_seq_set_data`; either fully replaces the sequence's attention
// KV and recurrent state. A partial snapshot restores its part through
// `llama_state_seq_set_data_ext` and then trims the attention KV to
// `snapshot.nPast`. For captured-but-empty snapshots
// (no payload, `nPast <= 0`), clears the sequence via
// `llama_memory_seq_rm` so the recurrent / hybrid memory rewinds to a
// truly empty state — the same end state the in-memory variant
// achieved by restoring the serialized empty-state bytes.
// No-op when `snapshot` is empty (i.e. nothing has been captured).
// Returns true on success, false when the captured-empty sequence
// clear is refused or the underlying load reports a 0-byte read
// (corrupted / missing / truncated file).
bool restoreSequenceState(
    ::llama_context* lctx, llama_seq_id seqId,
    const SequenceStateSnapshot& snapshot);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama

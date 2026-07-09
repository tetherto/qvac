#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include <llama.h>

namespace qvac_lib_inference_addon_llama {
namespace utils {

// Owning handle for a per-sequence state snapshot persisted to a temp
// file on disk. Captured via `llama_state_seq_save_file`, which under
// the hood calls `state_seq_write_data(io, seq_id, /*flags=*/0)` —
// llama.cpp's full-state sequence path, routed to disk instead of an
// in-memory byte buffer.
// On hybrid memories this covers BOTH the attention KV and the
// recurrent (SSM / RWKV) hidden state for `seqId`, so a later
// `llama_state_seq_load_file` rebuilds the entire sequence in one
// shot without needing `seq_rm` (which the recurrent module rejects
// for partial-tail ranges that include the final committed pos).
//
// Why disk: the in-memory variant duplicated the live cache buffer
// llama.cpp already owns. On hybrid models that buffer is large and
// the snapshot lifetime spans an entire turn, so the duplication was
// a meaningful overhead. The file path itself costs only a few dozen
// bytes; the heavy data sits in a temp file that is RAII-removed on
// clear / destruct / move-out.
//
// Move-only: the temp file is owned by this object. Copying would
// either alias the path (double delete) or duplicate the file (slow,
// wasteful) — neither is useful for our usage. Moves transfer file
// ownership and leave the source in an empty state.
//
// `nPast` records the next-position-to-write at snapshot time. The
// caller uses it as the replay anchor and the post-restore `nPast_`.
class RecurrentStateSnapshot {
public:
  RecurrentStateSnapshot() = default;
  ~RecurrentStateSnapshot();

  RecurrentStateSnapshot(const RecurrentStateSnapshot&) = delete;
  RecurrentStateSnapshot& operator=(const RecurrentStateSnapshot&) = delete;
  RecurrentStateSnapshot(RecurrentStateSnapshot&& other) noexcept;
  RecurrentStateSnapshot& operator=(RecurrentStateSnapshot&& other) noexcept;

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
  // empty" on restore). Mostly useful for tests / diagnostics.
  [[nodiscard]] bool hasFile() const noexcept { return !filePath_.empty(); }

  // Best-effort cleanup. Removes the underlying file (if any) and
  // resets `nPast` / `captured_`. Safe to call multiple times, safe on
  // a snapshot that never adopted a file.
  void clear() noexcept;

  // Test seam. Adopts a path without going through
  // `llama_state_seq_save_file`, so unit tests can exercise the
  // `hasReasoningBoundary()` / `empty()` gates without loading a real
  // `llama_context`. The path does not have to exist on disk —
  // production code MUST use `snapshotRecurrentState` instead so the
  // payload is actually valid for restore.
  void seedForTesting(std::string filePath, llama_pos nPastAt) noexcept;

  // Test seam. Marks the snapshot captured at `nPastAt` with no
  // backing file, mirroring the empty-sequence capture path. Lets
  // unit tests assert the captured-empty restore branch without
  // standing up a real `llama_context`.
  void seedEmptyForTesting(llama_pos nPastAt) noexcept;

  // Transfer ownership of a temp file produced by
  // `llama_state_seq_save_file` into this snapshot. Removes any
  // previously owned file. Used by `snapshotRecurrentState`; not
  // intended for general callers.
  void adoptFile(std::string filePath, llama_pos nPastAt) noexcept;

  // Mark this snapshot as a successful capture of an empty sequence
  // (no on-disk payload). Restore behaviour for this state is "clear
  // the sequence's memory" — equivalent to the legacy in-memory
  // `set_data_ext` on the empty-state serialization.
  void adoptEmpty(llama_pos nPastAt) noexcept;

private:
  std::string filePath_;
  bool captured_ = false;
};

// Captures the full state of `seqId` into `out` by writing it to a
// fresh per-process unique temp file via `llama_state_seq_save_file`,
// recording `nPastAt` alongside the path.
//
// Returns true on success. Returns false when the save call reports a
// 0-byte write — `out` is cleared (and any partial file removed) so a
// later restore cannot accidentally read a half-written payload.
//
// Empty sequences (`nPastAt <= 0`) are treated as a successful
// capture with no on-disk payload (see `adoptEmpty`); `out.empty()`
// returns false afterwards so the rollback gates know a capture has
// been recorded, and `restoreRecurrentState` will clear the sequence
// memory to match.
bool snapshotRecurrentState(
    ::llama_context* lctx, llama_seq_id seqId, llama_pos nPastAt,
    RecurrentStateSnapshot& out);

// Restores `snapshot` into `seqId`. For snapshots backed by a file,
// calls `llama_state_seq_load_file` to fully replace the sequence's
// attention KV and recurrent state. For captured-but-empty snapshots
// (no file, `nPast <= 0`), clears the sequence via
// `llama_memory_seq_rm` so the recurrent / hybrid memory rewinds to a
// truly empty state — the same end state the in-memory variant
// achieved by restoring the serialized empty-state bytes.
// No-op when `snapshot` is empty (i.e. nothing has been captured).
// Returns true on success, false when the captured-empty sequence
// clear is refused or the underlying load reports a 0-byte read
// (corrupted / missing / truncated file).
bool restoreRecurrentState(
    ::llama_context* lctx, llama_seq_id seqId,
    const RecurrentStateSnapshot& snapshot);

// Replays `tokens` through `lctx` against `seqId`, attaching them to
// positions starting at `startPos` (so position[i] == startPos + i).
// Used after a partial-state restore to advance the recurrent state
// across the post-reasoning span without re-running the sampler. The
// batch is chunked to fit within `llama_n_batch(lctx)` so callers can
// pass arbitrarily long token vectors.
//
// `outputLogitsForLast` controls whether the final token in `tokens`
// requests output logits from `llama_decode` — set true when the
// caller intends to immediately sample the next token from the
// post-replay state, false when the replay is purely for SSM advance.
//
// Returns true on success. Returns false if any sub-batch decode call
// reports a non-zero error code; the caller should treat the recurrent
// state as undefined in that case (the attention KV the caller
// previously compacted is unaffected).
bool replayTokensThroughDecoder(
    ::llama_context* lctx, llama_seq_id seqId,
    const std::vector<llama_token>& tokens, llama_pos startPos,
    bool outputLogitsForLast = false);

using ReplayDecodeFunc = std::function<int(::llama_context*, llama_batch)>;

// Test seam for replay chunking and failure propagation. Production callers
// should use `replayTokensThroughDecoder`, which derives the chunk size from
// the live context and decodes with llama.cpp directly.
bool replayTokensThroughDecoderForTesting(
    ::llama_context* lctx, llama_seq_id seqId,
    const std::vector<llama_token>& tokens, llama_pos startPos,
    bool outputLogitsForLast, int32_t chunkSize, ReplayDecodeFunc decodeFunc);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama

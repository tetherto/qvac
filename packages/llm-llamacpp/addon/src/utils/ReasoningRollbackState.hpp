#pragma once

#include <cstddef>
#include <string>
#include <vector>

#include <llama.h>

#include "RecurrentStateSnapshot.hpp"
#include "SessionCheckpointMetadata.hpp"

namespace qvac_lib_inference_addon_llama {
namespace utils {

// Shared per-inference transaction and reasoning-replay state.
//
//   * an optional persistent transaction checkpoint pinning the last committed
//     cache artifact through a stable hard-link identity;
//   * an end-of-prefill temporary full-state snapshot restored by
//     thinking-block compaction;
//   * the post-reasoning token capture buffer used to replay the
//     visible answer after restoring the end-of-prefill snapshot.
//
// Failure handling stays in the caller: `capture*` and `restore*`
// return false when the underlying llama.cpp call short-reads, and the
// caller decides how to surface that. Under the uniform
// `remove_thinking_from_context` hard-fail contract (PR #2813), the
// end-of-prefill reasoning-boundary capture site
// (`ReasoningBlockCompactor::snapshotAtPrefillBoundary`) throws
// `qvac_errors::StatusError` on underflow, and hybrid restore/replay
// failures inside `compact()` also throw. Persistent baseline commit failures
// abort before request memory mutation.
//
// Transaction checkpoint configuration is set before request evaluation and
// cleared on completion. Reasoning state is independently reset per inference.
class ReasoningRollbackState {
public:
  // ---- Pre-request transaction checkpoint ----
  //
  // Persistent requests pin the committed cache artifact. Empty persistent
  // baselines use an in-memory marker. Non-persistent requests hold no
  // checkpoint and cancellation clears the affected sequence.
  void setPersistentTransactionCheckpoint(
      std::string path, const SessionCheckpointMetadata& metadata) noexcept;
  void setEmptyTransactionCheckpoint() noexcept;
  void clearTransactionCheckpoint() noexcept;
  bool restoreTransactionCheckpoint(::llama_context* ctx, llama_seq_id seqId);
  [[nodiscard]] bool hasTransactionCheckpoint() const noexcept {
    return transactionCheckpointKind_ != TransactionCheckpointKind::None;
  }
  [[nodiscard]] const SessionCheckpointMetadata&
  transactionCheckpointMetadata() const noexcept {
    return transactionCheckpointMetadata_;
  }

  // ---- End-of-prefill snapshot (compaction + cancel during generation) ----
  //
  // No-op if a snapshot already exists for this inference, so the
  // caller doesn't have to re-check before invoking. Returns false on
  // capture failure (the snapshot is cleared in that case).
  bool captureReasoningBoundary(
      ::llama_context* ctx, llama_seq_id seqId, llama_pos nPast);
  // No-op when no snapshot is held. Returns false only when a held
  // snapshot fails to restore.
  bool restoreReasoningBoundary(::llama_context* ctx, llama_seq_id seqId);
  [[nodiscard]] bool hasReasoningBoundary() const noexcept {
    return !reasoningBoundary_.empty();
  }
  [[nodiscard]] llama_pos reasoningBoundaryNPast() const noexcept {
    return reasoningBoundary_.nPast;
  }
  void clearReasoningBoundary() noexcept { reasoningBoundary_.clear(); }

  // ---- Post-reasoning capture (replay buffer) ----
  //
  // Capture is started by the caller once the close marker has been
  // committed AND a reasoning-boundary snapshot exists. Tokens are
  // appended only while capture is active; `recordPostReasoningToken`
  // is a no-op for inactive capture or null token ids.
  void startPostReasoningCapture(bool enable) noexcept {
    capturingPostReasoning_ = enable;
  }
  [[nodiscard]] bool isCapturingPostReasoning() const noexcept {
    return capturingPostReasoning_;
  }
  void recordPostReasoningToken(llama_token id);
  // Unconditional append used to seed the replay buffer with the close
  // marker token id (and any other tokens that must land in the
  // replayed prefix) before `capturingPostReasoning_` is flipped on.
  // Skips null token ids; never checks the capture flag. Bumps the
  // seeded-prefix counter so `clipPostReasoningTokens` cannot drop
  // structural tokens.
  void appendPostReasoningToken(llama_token id);
  [[nodiscard]] const std::vector<llama_token>&
  postReasoningTokens() const noexcept {
    return postReasoningTokens_;
  }
  [[nodiscard]] size_t postReasoningTokenCount() const noexcept {
    return postReasoningTokens_.size();
  }
  // Number of seeded structural tokens at the head of the replay
  // buffer (close marker, etc.) that `clipPostReasoningTokens` must
  // preserve regardless of the live-cache tail size.
  [[nodiscard]] size_t seededPostReasoningCount() const noexcept {
    return seededPostReasoningCount_;
  }
  // Truncate the replay buffer so the captured suffix holds at most
  // `maxCapturedTail` tokens. The seeded prefix (close marker + any
  // other tokens added via `appendPostReasoningToken`) is never
  // dropped, so passing 0 still preserves the structural prefix.
  // Used when the tools-compact tail trim shrinks the live tail
  // between close-marker capture and replay.
  void clipPostReasoningTokens(size_t maxCapturedTail);
  void clearPostReasoning() noexcept;

  // Replays captured tokens through the decoder, attaching them at
  // positions starting at `reasoningBoundaryNPast()`. Caller should
  // ensure the boundary snapshot was already restored. Returns false
  // if any sub-batch decode call reports a non-zero error.
  bool replayPostReasoning(::llama_context* ctx, llama_seq_id seqId);

  // Clears all per-inference state. Safe to call regardless of which
  // (if any) snapshots are currently held.
  void reset() noexcept;

  // Test seam. Seeds the reasoning-boundary snapshot with a sentinel
  // file path so unit tests can exercise downstream gates that depend
  // on `hasReasoningBoundary()` without loading a real `llama_context`.
  // Production code MUST use `captureReasoningBoundary` instead — the
  // path here is not a valid llama state file and would fail
  // `llama_state_seq_load_file` if anything tried to restore from it.
  void seedReasoningBoundaryForTesting(llama_pos nPast) noexcept;

  void seedTransactionCheckpointForTesting(llama_pos nPast) noexcept;
  void forceReplayFailureForTesting(bool value) noexcept {
    forceReplayFailureForTesting_ = value;
  }

private:
  enum class TransactionCheckpointKind { None, Empty, Persistent };
  TransactionCheckpointKind transactionCheckpointKind_ =
      TransactionCheckpointKind::None;
  std::string transactionCheckpointPath_;
  bool ownsTransactionCheckpointPath_ = false;
  SessionCheckpointMetadata transactionCheckpointMetadata_;
  RecurrentStateSnapshot reasoningBoundary_;
  std::vector<llama_token> postReasoningTokens_;
  // Count of structural tokens at the head of `postReasoningTokens_`
  // that must survive `clipPostReasoningTokens`. Incremented by
  // `appendPostReasoningToken`; reset to zero whenever the buffer is
  // cleared.
  size_t seededPostReasoningCount_ = 0;
  bool capturingPostReasoning_ = false;
  bool forceReplayFailureForTesting_ = false;
};

} // namespace utils
} // namespace qvac_lib_inference_addon_llama

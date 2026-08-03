#include "ReasoningRollbackState.hpp"

#include <cstddef>
#include <utility>

#include "RecurrentStateSnapshot.hpp"

namespace qvac_lib_inference_addon_llama {
namespace utils {

void ReasoningRollbackState::setPersistentTransactionCheckpoint(
    std::string path, llama_pos nPast) noexcept {
  transactionCheckpointKind_ = TransactionCheckpointKind::Persistent;
  transactionCheckpointPath_ = std::move(path);
  transactionCheckpointNPast_ = nPast;
}

void ReasoningRollbackState::setEmptyTransactionCheckpoint() noexcept {
  transactionCheckpointKind_ = TransactionCheckpointKind::Empty;
  transactionCheckpointPath_.clear();
  transactionCheckpointNPast_ = 0;
}

void ReasoningRollbackState::clearTransactionCheckpoint() noexcept {
  transactionCheckpointKind_ = TransactionCheckpointKind::None;
  transactionCheckpointPath_.clear();
  transactionCheckpointNPast_ = 0;
}

bool ReasoningRollbackState::restoreTransactionCheckpoint(
    ::llama_context* ctx, llama_seq_id seqId) {
  if (ctx == nullptr ||
      transactionCheckpointKind_ == TransactionCheckpointKind::None) {
    return false;
  }
  if (transactionCheckpointKind_ == TransactionCheckpointKind::Empty) {
    auto* mem = llama_get_memory(ctx);
    return mem != nullptr && llama_memory_seq_rm(mem, seqId, -1, -1);
  }
  size_t tokenCount = 0;
  const size_t loadedBytes = llama_state_seq_load_file(
      ctx,
      transactionCheckpointPath_.c_str(),
      seqId,
      /*tokens_out=*/nullptr,
      /*n_token_capacity=*/0,
      &tokenCount);
  return loadedBytes != 0;
}

bool ReasoningRollbackState::captureReasoningBoundary(
    ::llama_context* ctx, llama_seq_id seqId, llama_pos nPast) {
  if (!reasoningBoundary_.empty()) {
    // Already snapshotted this inference; subsequent calls are no-ops
    // so callers don't have to gate before invoking.
    return true;
  }
  if (!snapshotRecurrentState(ctx, seqId, nPast, reasoningBoundary_)) {
    // Defensive: the primitive clears on short-read, but make sure
    // `hasReasoningBoundary()` cannot accidentally report true after a
    // failed capture.
    reasoningBoundary_.clear();
    return false;
  }
  return true;
}

bool ReasoningRollbackState::restoreReasoningBoundary(
    ::llama_context* ctx, llama_seq_id seqId) {
  if (reasoningBoundary_.empty()) {
    return false;
  }
  return restoreRecurrentState(ctx, seqId, reasoningBoundary_);
}

void ReasoningRollbackState::recordPostReasoningToken(llama_token id) {
  if (!capturingPostReasoning_ || id == LLAMA_TOKEN_NULL) {
    return;
  }
  postReasoningTokens_.push_back(id);
}

void ReasoningRollbackState::appendPostReasoningToken(llama_token id) {
  if (id == LLAMA_TOKEN_NULL) {
    return;
  }
  postReasoningTokens_.push_back(id);
  ++seededPostReasoningCount_;
}

void ReasoningRollbackState::clipPostReasoningTokens(size_t maxCapturedTail) {
  const size_t maxTotal = seededPostReasoningCount_ + maxCapturedTail;
  if (postReasoningTokens_.size() > maxTotal) {
    postReasoningTokens_.resize(maxTotal);
  }
}

void ReasoningRollbackState::clearPostReasoning() noexcept {
  postReasoningTokens_.clear();
  seededPostReasoningCount_ = 0;
  capturingPostReasoning_ = false;
  forceReplayFailureForTesting_ = false;
}

bool ReasoningRollbackState::replayPostReasoning(
    ::llama_context* ctx, llama_seq_id seqId) {
  if (postReasoningTokens_.empty()) {
    return true;
  }
  if (forceReplayFailureForTesting_) {
    forceReplayFailureForTesting_ = false;
    return false;
  }
  return replayTokensThroughDecoder(
      ctx, seqId, postReasoningTokens_, reasoningBoundary_.nPast);
}

void ReasoningRollbackState::reset() noexcept {
  clearTransactionCheckpoint();
  reasoningBoundary_.clear();
  postReasoningTokens_.clear();
  seededPostReasoningCount_ = 0;
  capturingPostReasoning_ = false;
  forceReplayFailureForTesting_ = false;
}

void ReasoningRollbackState::seedReasoningBoundaryForTesting(
    llama_pos nPast) noexcept {
  // Sentinel path — does not point at a real llama state file. Only
  // the `hasReasoningBoundary()` / `empty()` gates are exercised by
  // tests that call this seam; any restore attempt would fail
  // `llama_state_seq_load_file` (and is correctly never invoked from
  // these tests).
  reasoningBoundary_.seedForTesting(
      "qvac_test_reasoning_boundary_sentinel.bin", nPast);
}

void ReasoningRollbackState::seedTransactionCheckpointForTesting(
    llama_pos nPast) noexcept {
  setPersistentTransactionCheckpoint(
      "qvac_test_transaction_checkpoint_sentinel.bin", nPast);
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama

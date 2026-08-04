#include "ReasoningRollbackState.hpp"

#include <array>
#include <cstddef>
#include <filesystem>
#include <optional>
#include <utility>

#include "RecurrentStateSnapshot.hpp"

namespace qvac_lib_inference_addon_llama {
namespace utils {

namespace {
std::optional<CacheArtifactIdentity>
readArtifactIdentity(const std::string& path) {
  std::error_code ec;
  const auto size = std::filesystem::file_size(path, ec);
  if (ec) {
    return std::nullopt;
  }
  const auto modified = std::filesystem::last_write_time(path, ec);
  if (ec) {
    return std::nullopt;
  }
  return CacheArtifactIdentity{
      .fileSize = size,
      .modifiedTicks =
          static_cast<int64_t>(modified.time_since_epoch().count())};
}
} // namespace

void ReasoningRollbackState::setPersistentTransactionCheckpoint(
    std::string path, const SessionCheckpointMetadata& metadata,
    const CacheArtifactIdentity& identity) noexcept {
  clearTransactionCheckpoint();
  transactionCheckpointKind_ = TransactionCheckpointKind::Persistent;
  transactionCheckpointPath_ = std::move(path);
  transactionCheckpointIdentity_ = identity;
  transactionCheckpointMetadata_ = metadata;
}

void ReasoningRollbackState::setEmptyTransactionCheckpoint() noexcept {
  clearTransactionCheckpoint();
  transactionCheckpointKind_ = TransactionCheckpointKind::Empty;
  transactionCheckpointPath_.clear();
  transactionCheckpointIdentity_ = {};
  transactionCheckpointMetadata_ = {};
}

void ReasoningRollbackState::clearTransactionCheckpoint() noexcept {
  transactionCheckpointKind_ = TransactionCheckpointKind::None;
  transactionCheckpointPath_.clear();
  transactionCheckpointIdentity_ = {};
  transactionCheckpointMetadata_ = {};
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
  const auto currentIdentity = readArtifactIdentity(transactionCheckpointPath_);
  if (!currentIdentity.has_value() ||
      *currentIdentity != transactionCheckpointIdentity_) {
    return false;
  }
  auto* mem = llama_get_memory(ctx);
  if (mem == nullptr) {
    return false;
  }
  auto sequenceEmpty = [mem, seqId]() {
    return llama_memory_seq_pos_max(mem, seqId) < 0 &&
           llama_memory_seq_token_count(mem, seqId) == 0;
  };
  auto clearSequence = [mem, seqId, &sequenceEmpty]() {
    (void)llama_memory_seq_rm(mem, seqId, -1, -1);
    return sequenceEmpty();
  };
  // Drop interrupted prompt/output state before loading the pinned artifact;
  // restore must not rely on the loader replacing every existing cell.
  if (!clearSequence()) {
    return false;
  }
  std::array<llama_token, 4> metadataTokens{};
  size_t tokenCount = 0;
  const size_t loadedBytes = llama_state_seq_load_file(
      ctx,
      transactionCheckpointPath_.c_str(),
      seqId,
      metadataTokens.data(),
      metadataTokens.size(),
      &tokenCount);
  if (loadedBytes == 0 || tokenCount != metadataTokens.size()) {
    (void)clearSequence();
    return false;
  }
  const bool metadataMatches =
      metadataTokens[0] == transactionCheckpointMetadata_.nPast &&
      metadataTokens[1] == transactionCheckpointMetadata_.firstMsgTokens &&
      metadataTokens[2] == transactionCheckpointMetadata_.cacheTokens &&
      metadataTokens[3] == transactionCheckpointMetadata_.firstMsgCacheTokens;
  if (!metadataMatches) {
    (void)clearSequence();
    return false;
  }
  const llama_pos loadedNPast = llama_memory_seq_pos_max(mem, seqId) + 1;
  const llama_pos loadedCacheTokens =
      static_cast<llama_pos>(llama_memory_seq_token_count(mem, seqId));
  if (loadedNPast != transactionCheckpointMetadata_.nPast ||
      loadedCacheTokens != transactionCheckpointMetadata_.cacheTokens) {
    (void)clearSequence();
    return false;
  }
  return true;
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
      "qvac_test_transaction_checkpoint_sentinel.bin",
      SessionCheckpointMetadata{
          .nPast = nPast,
          .firstMsgTokens = nPast,
          .cacheTokens = nPast,
          .firstMsgCacheTokens = nPast},
      {});
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama

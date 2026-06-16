#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

#include <llama.h>

#include "LlmContext.hpp"

namespace qvac_lib_inference_addon_llama::batching {

enum class StopReason : uint8_t {
  None,
  Finished,     // Explicitly marked finished (e.g., EOG sampled)
  LimitReached, // Reached maxTokensPerSequence
  DecodeError,  // llama_decode returned a non-zero rc
  Cancelled,
};

struct Request {
  uint32_t seqId;
  std::vector<llama_token> pendingPrefillTokens;
  size_t prefillTokenCount = 0;
  size_t prefillFedCount = 0;
  std::vector<llama_token> generatedTokens;
  llama_pos currentPos = 0;
  bool hasUnfedSample = false;
  /// When true, the sequence driver can slide its context window during
  /// generation: `exceededLimit()` then lets the position reach the cap
  /// so the slide (which drops it back below) gets a chance to fire
  /// instead of hard-truncating the sequence.
  bool slideCapable = false;
  StopReason stopReason = StopReason::None;
  unsigned maxTokensPerSequence;

  Request(
      uint32_t rid, std::vector<llama_token>&& toks, unsigned maxTokens,
      llama_pos initialPos = 0, bool canSlide = false);

  [[nodiscard]] bool isPrefillComplete() const;
  [[nodiscard]] bool exceededLimit() const;
  [[nodiscard]] bool isFinished() const;
  static bool isOptFinished(const std::optional<Request>& slot);
  static bool isOptActive(const std::optional<Request>& slot);
  [[nodiscard]] bool isPrefillPending() const;
  static bool isOptPrefillPending(const std::optional<Request>& slot);
  [[nodiscard]] bool isGenerationIdle() const;
  static bool isOptGenerationIdle(const std::optional<Request>& slot);
  [[nodiscard]] bool isGenerationPending() const;
  static bool isOptGenerationPending(const std::optional<Request>& slot);
  [[nodiscard]] bool hasTokensToFeed() const;
  static bool isOptHasTokensToFeed(const std::optional<Request>& slot);
  [[nodiscard]] unsigned remainingToFeed() const;
  [[nodiscard]] llama_token tokenToFeedAt(llama_pos pos) const;
  [[nodiscard]] bool chunkConsumesAllUnfed(unsigned chunkSize) const;
};

/// Handles batching multiple requests into a single llama_batch for
/// continuous batching. Manages sequence IDs and attention mask setup.
/// Not thread-safe; caller must ensure single-threaded access.
///
/// Uses slot-based storage: a fixed-size vector of optional Requests where
/// each index is the seqId. Free slots can be reused as completed
/// sequences are evicted, enabling continuous admission of new requests.
class MultiRequestBatcher {
public:
  /// @param maxChunkSize Max tokens per sequence per fillBatch() call.
  /// @param maxTokensPerSequence Hard limit on total sequence length (prompt +
  /// generated tokens). If a prompt's length equals this limit, the request is
  /// accepted but finishes immediately after prefill.
  /// @param batchSize Max concurrent sequences.
  MultiRequestBatcher(
      unsigned maxChunkSize, unsigned maxTokensPerSequence, size_t batchSize)
      : maxChunkSize_(maxChunkSize),
        maxTokensPerSequence_(maxTokensPerSequence), slots_(batchSize),
        lastLogitIndices_(batchSize, -1) {}

  enum class AddStatus : int8_t {
    Ok,
    ErrNoFreeSlot,
    ErrTokensTooLarge,
    ErrEmptyTokens,
  };

  [[nodiscard]] AddStatus
  addRequest(std::vector<llama_token>&& tokens, uint32_t& seqId);
  [[nodiscard]] AddStatus addRequestAt(
      uint32_t seqId, std::vector<llama_token>&& tokens,
      llama_pos initialPos = 0, bool slideCapable = false);

  [[nodiscard]] std::optional<uint32_t> firstFreeSeqId() const;

  /// `logitIdx` is always >=0: sampleAndAppendIdle only fires for slots
  /// whose chunk consumed all unfed tokens, i.e. exactly when fillBatch set
  /// logits[idx]=1. Pass to llama_get_logits_ith(ctx, idx).
  using SamplerFn = std::function<llama_token(uint32_t seqId, int logitIdx)>;

  /// Generation-step entry point. Must be called after fillBatch() +
  /// llama_decode() and before the next fillBatch(): the per-slot
  /// logit-index bookkeeping it relies on is refreshed by every fillBatch().
  void sampleAndAppendIdle(const SamplerFn& samplerFn);

  bool markFinished(uint32_t seqId, StopReason reason = StopReason::Finished);

  /// Drop `discarded` tokens from a sequence's position after the driver
  /// performed an in-step context slide, so the next token feeds at the
  /// compacted position.
  void applySlide(uint32_t seqId, llama_pos discarded);

  /// Mark every active slot as finished with `reason`. Used to terminate
  /// all in-flight requests (e.g. on a fatal decode error). No-op for
  /// already-finished slots.
  void markAllFinished(StopReason reason);

  /// Per-seqId KV-cache clear callback invoked when a slot is freed.
  /// Production callers bind it to llama_memory_seq_rm so stale entries for
  /// that seqId are dropped before the slot is reused. An empty function
  /// skips the call (tests may pass a recording lambda instead).
  using KvClearFn = std::function<void(uint32_t seqId)>;
  using PrefillCompleteFn = std::function<void(
      uint32_t seqId, llama_pos currentPos, size_t prefillTokenCount)>;

  struct FillResult {
    unsigned chunkSize;
    unsigned numActiveSequences;
    /// Active slots still feeding prompt tokens this step. The remaining
    /// `numActiveSequences - numPrefillingSequences` slots are generating.
    /// Lets callers split a step's `chunkSize` tokens into prompt vs decode.
    unsigned numPrefillingSequences = 0;
  };

  /// Fill batch with tokens from active slots. Never writes past
  /// `batch.capacity()`; if the batch cannot hold at least one token per
  /// active sequence, returns `chunkSize == 0` and leaves the batch empty.
  /// Side effect: refreshes the per-slot logit-index bookkeeping consumed
  /// by the next sampleAndAppendIdle() call.
  [[nodiscard]] FillResult fillBatch(LlamaBatch& batch);

  void
  advance(unsigned chunkSize, const PrefillCompleteFn& onPrefillComplete = {});

  /// Extract finished requests and free their slots. Callers are responsible
  /// for clearing the freed seqIds' KV-cache entries before reusing the slots.
  std::vector<Request> extractFinished();

  /// @param kvClear invoked with seqId iff the slot was occupied and is now
  ///        freed (matches the return value).
  /// @return true if the slot was occupied and is now freed
  bool cancel(uint32_t seqId, const KvClearFn& kvClear = {});

  /// Drop every slot. `kvClear` (when non-empty) is invoked once per
  /// previously occupied slot, in seqId order.
  void clear(const KvClearFn& kvClear = {});

  [[nodiscard]] bool isValid(uint32_t seqId) const;

  [[nodiscard]] const Request* requestAt(uint32_t seqId) const;

private:
  unsigned maxChunkSize_, maxTokensPerSequence_;

  std::vector<std::optional<Request>> slots_;

  /// Per-slot batch index where fillBatch() last set logits=1, indexed by
  /// seqId. -1 when no logits were requested for that slot in the most
  /// recent fillBatch(). Reset to -1 at the top of every fillBatch().
  std::vector<int> lastLogitIndices_;

  [[nodiscard]] FillResult
  getChunkSizeForActiveSeqs(const LlamaBatch& batch) const;
};

} // namespace qvac_lib_inference_addon_llama::batching

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
};

struct Request {
  uint32_t seqId;
  std::vector<llama_token> pendingPrefillTokens;
  size_t prefillFedCount = 0;
  std::vector<llama_token> generatedTokens;
  llama_pos currentPos = 0;
  bool hasUnfedSample = false;
  StopReason stopReason = StopReason::None;
  unsigned maxTokensPerSequence;

  Request(uint32_t rid, std::vector<llama_token>&& toks, unsigned maxTokens);

  // True once every prompt token has been fed.
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
  /// @param maxTokensPerSequence Hard limit on total sequence length (prompt + generated tokens).
  /// If a prompt's length equals this limit, the request is accepted but finishes immediately after prefill.
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

  /// Add a request to a free slot.
  [[nodiscard]] AddStatus
  addRequest(std::vector<llama_token>&& tokens, uint32_t& seqId);

  /// Per-slot sampler callback.
  /// @param seqId    sequence whose logits are ready to sample
  /// @param logitIdx batch index where logits were requested for this seqId
  ///                 in the last fillBatch() (always >=0 here because
  ///                 sampleAndAppendIdle only invokes the callback for
  ///                 slots whose chunk consumed all unfed tokens, which is
  ///                 exactly the condition under which fillBatch sets
  ///                 logits[idx]=1). Pass to llama_get_logits_ith(ctx, idx).
  using SamplerFn = std::function<llama_token(uint32_t seqId, int logitIdx)>;

  /// Generation-step entry point. Must be called after fillBatch() +
  /// llama_decode() and before the next fillBatch(): the per-slot
  /// logit-index bookkeeping it relies on is refreshed by every fillBatch().
  void sampleAndAppendIdle(const SamplerFn& samplerFn);

  /// Mark a slot as finished with the explicit `StopReason::Finished`.
  bool markFinished(uint32_t seqId);

  /// Mark every active slot as finished with `reason`. Used to terminate
  /// all in-flight requests (e.g. on a fatal decode error). No-op for
  /// already-finished slots.
  void markAllFinished(StopReason reason);

  /// Per-seqId KV-cache clear callback invoked when a slot is freed.
  /// Production callers should bind it to llama_memory_seq_rm so the
  /// underlying llama_context drops every entry tagged with that seqId
  /// before the slot is handed out to a new request:
  ///   `[ctx](uint32_t s) {
  ///      llama_memory_seq_rm(llama_get_memory(ctx), s, -1, -1);
  ///    }`
  /// Tests may pass a recording lambda. An empty std::function skips the
  /// call entirely.
  using KvClearFn = std::function<void(uint32_t seqId)>;

  struct FillResult {
    unsigned chunkSize;
    unsigned numActiveSequences;
  };

  /// Fill batch with tokens from active slots. Never writes past
  /// `batch.capacity()`; if the batch cannot hold at least one token per
  /// active sequence, returns `chunkSize == 0` and leaves the batch empty.
  /// Side effect: refreshes the per-slot logit-index bookkeeping consumed
  /// by the next sampleAndAppendIdle() call.
  [[nodiscard]] FillResult fillBatch(LlamaBatch& batch);

  /// Advance currentPos for active sequences.
  void advance(unsigned chunkSize);

  /// Extract finished requests and free their slots. For every freed slot
  /// `kvClear` (when non-empty) is invoked with the slot's seqId before the
  /// slot is reset, so callers cannot accidentally let stale KV-cache
  /// entries bleed into a reused slot.
  std::vector<Request> extractFinished(const KvClearFn& kvClear = {});

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

  // Flat storage enough for typical batch sizes.
  // Small numbers such as 16 can already provide optimal perf.
  std::vector<std::optional<Request>> slots_;

  /// Per-slot batch index where fillBatch() last set logits=1, indexed by
  /// seqId. -1 when no logits were requested for that slot in the most
  /// recent fillBatch(). Reset to -1 at the top of every fillBatch().
  std::vector<int> lastLogitIndices_;

  [[nodiscard]] FillResult getChunkSizeForActiveSeqs(const LlamaBatch& batch) const;
};

} // namespace qvac_lib_inference_addon_llama::batching

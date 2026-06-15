#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include <common/chat.h>
#include <llama.h>

class LlamaBatch;
struct PromptLayout;

/// Per-sequence step outcome reported by `SequenceDriver::onLogitsReady`.
/// `decodedInline` lets a driver piggy-back a fresh `llama_decode` (for
/// example to flush a forced follow-up token) without bouncing through
/// the scheduler's main batch.
struct SequenceStepResult {
  llama_token token = LLAMA_TOKEN_NULL;
  bool finished = false;
  bool decodedInline = false;
  bool contextOverflow = false;
  /// Tokens dropped from this sequence's KV-cache by an in-step context
  /// slide. The scheduler must subtract it from the request's position
  /// before feeding the next token.
  llama_pos discarded = 0;
};

/// Standalone per-sequence driver interface exercised by the
/// `ContinuousBatchScheduler`. One instance owns the state of a single
/// in-flight sequence (KV-cache offset, sampler, antiprompt buffer, ...)
/// and reacts to scheduler-driven lifecycle events.
///
/// Intentionally decoupled from `LlmContext` so a new `LlmContext`
/// capability does not pollute the scheduler's view of a sequence.
/// `TextLlmContext` implements both interfaces.
///
/// Method ordering below mirrors a sequence's lifecycle:
///   `validatePromptPolicy` -> `loadCache` -> `preparePrefill`
///   -> `onPrefillComplete` -> N x `onLogitsReady` ->
///   (`onGenerationFinished` | `onCancel`) -> `onSequenceEnd` ->
///   `saveCache`
class SequenceDriver {
public:
  SequenceDriver() = default;
  SequenceDriver(const SequenceDriver&) = delete;
  SequenceDriver& operator=(const SequenceDriver&) = delete;
  SequenceDriver(SequenceDriver&&) = delete;
  SequenceDriver& operator=(SequenceDriver&&) = delete;
  virtual ~SequenceDriver() = default;

  [[nodiscard]] virtual llama_pos getNPast() const = 0;

  [[nodiscard]] virtual int32_t getNSlides() const = 0;

  /// Reject prompts that violate per-sequence admission policy (size,
  /// layout, KV-cache state). Called once per `submit` before any state
  /// is mutated; a thrown `StatusError` aborts admission cleanly.
  virtual void validatePromptPolicy(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, const PromptLayout& layout,
      bool hasKvCacheContext) const = 0;

  /// Tokenize the prompt and stage it for prefill (without running
  /// generation). Returns the tokens still pending decode by the
  /// scheduler at admission time.
  virtual std::vector<llama_token> preparePrefill(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
      bool prefill) = 0;

  /// Notify the driver that the scheduler has finished prefill-decoding
  /// `prefillTokenCount` tokens up to absolute position `currentPos`.
  virtual void
  onPrefillComplete(llama_pos currentPos, size_t prefillTokenCount) = 0;

  /// Reconcile the driver's KV position with the batcher's authoritative
  /// per-request position. Called by the scheduler before every
  /// `onLogitsReady` so context-window decisions (sliding, overflow) see
  /// the live value rather than one frozen at prefill time.
  virtual void syncPosition(llama_pos currentPos) = 0;

  /// Driven by the scheduler once `llama_decode` has produced logits for
  /// this sequence's last batch entry. Implementations sample the next
  /// token, run any driver-specific bookkeeping, and report back via
  /// `SequenceStepResult`. `inlineDecodeBatch`, when non-null, may be
  /// used to piggy-back a forced follow-up `llama_decode` outside of the
  /// scheduler's main batch.
  virtual SequenceStepResult onLogitsReady(
      int logitIdx, unsigned generatedAfterAccept,
      const std::function<void(const std::string&)>& outputCallback,
      LlamaBatch* inlineDecodeBatch = nullptr) = 0;

  /// Final-token / clean-shutdown hook. Implementations should flush any
  /// pending UTF-8 buffer state and close streams. Called exactly once
  /// per admitted sequence by the scheduler, including the cancel /
  /// decode-error / scheduler-teardown paths.
  virtual void onSequenceEnd(
      const std::function<void(const std::string&)>& outputCallback) = 0;

  /// Fired when generation reaches a natural EOG / stop token.
  virtual void onGenerationFinished(
      const std::function<void(const std::string&)>& outputCallback) = 0;

  /// Fired when the sequence is cancelled (user-requested or fatal error).
  virtual void
  onCancel(const std::function<void(const std::string&)>& outputCallback) = 0;

  /// Try to populate this sequence's KV-cache from a previously
  /// persisted cache. Returns true when the cache was loaded
  /// successfully; the scheduler then skips the corresponding prefix
  /// tokens at admit time.
  [[nodiscard]] virtual bool
  loadCache(const std::string& cacheKey, llama_pos configuredNDiscarded) = 0;

  virtual void saveCache(const std::string& cacheKey) const = 0;
};

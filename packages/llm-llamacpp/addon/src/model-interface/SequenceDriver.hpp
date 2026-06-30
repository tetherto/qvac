#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <numeric>
#include <string>
#include <vector>

#include <common/chat.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "MediaLoadOrder.hpp"
#include "addon/LlmErrors.hpp"

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

/// A non-token unit of prefill work (image/audio embedding chunk) staged
/// between text tokens. `afterTextTokens` anchors the barrier inside
/// `PrefillPlan::tokens`: the batcher stops feeding that slot once it has
/// fed this many text tokens and waits for the scheduler to call
/// `SequenceDriver::evalMediaSegment(mediaIndex, pos)`. `nPos` is the
/// positional span the segment will occupy (M-RoPE media can occupy fewer
/// positions than KV cells) and is only used for admission-time sizing;
/// the authoritative post-eval position comes from `evalMediaSegment`.
/// `nKvTokens` is the number of KV cells the segment consumes; for M-RoPE
/// media `nKvTokens >= nPos`, so both must be checked against their caps
/// at admission time.
struct MediaBarrier {
  size_t afterTextTokens = 0;
  size_t mediaIndex = 0;
  llama_pos nPos = 0;
  llama_pos nKvTokens = 0;
};

/// Staged prefill returned by `SequenceDriver::preparePrefill`: the flat
/// text-token stream plus the media barriers interleaved into it, ordered
/// by `afterTextTokens`. Text-only drivers return an empty barrier list.
struct PrefillPlan {
  std::vector<llama_token> tokens;
  std::vector<MediaBarrier> mediaBarriers;

  /// Total positional span of the staged prompt (text + media).
  [[nodiscard]] llama_pos totalPositions() const {
    return std::accumulate(
        mediaBarriers.begin(),
        mediaBarriers.end(),
        static_cast<llama_pos>(tokens.size()),
        [](llama_pos acc, const MediaBarrier& b) { return acc + b.nPos; });
  }

  /// Total KV cells the staged prompt consumes (text + media). For M-RoPE
  /// media this exceeds `totalPositions()`, so admission must check it
  /// against the KV-cache budget independently of the position span.
  [[nodiscard]] llama_pos totalKvTokens() const {
    return std::accumulate(
        mediaBarriers.begin(),
        mediaBarriers.end(),
        static_cast<llama_pos>(tokens.size()),
        [](llama_pos acc, const MediaBarrier& b) { return acc + b.nKvTokens; });
  }
};

/// Whether `count` tokens (or KV cells) are too many for a `ceiling`-sized
/// per-slot window. Shared by every driver's prefill admission so the text and
/// MTMD paths apply the same rule and match the scheduler's own admission.
///
/// A prefill-only request may exactly fill the window: even when it is fully
/// occupied it will not generate more tokens later, so exactly full is fine and
/// only strictly over is rejected. A request that will generate needs at least
/// one more free slot for the next token, so a full window is already too many.
[[nodiscard]] inline bool exceedsContextWindow(
    llama_pos count, llama_pos ceiling, bool isPrefillOnlyRequest) {
  return isPrefillOnlyRequest ? count > ceiling : count >= ceiling;
}

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

  /// Physical KV-cell usage already committed for this sequence (e.g. a
  /// restored cache). Defaults to `getNPast()` for text drivers, where cells
  /// and positions coincide. M-RoPE media drivers commit more cells than
  /// positions, so admission must size the KV-cap and generation-budget checks
  /// from this value rather than `getNPast()`.
  [[nodiscard]] virtual llama_pos getKvCellsUsed() const { return getNPast(); }

  [[nodiscard]] virtual int32_t getNSlides() const = 0;

  [[nodiscard]] virtual int32_t getThinkingBlockDiscards() const { return 0; }

  // Apply the per-request `remove_thinking_from_context` toggle to the
  // driver. The single-prompt path goes through `applyGenerationParams`
  // (which restores on scope exit); the batch path uses this setter
  // directly because each slot has a fresh driver per request, so no
  // restore is needed. Default no-op for drivers without compaction
  // support.

  virtual void setRemoveThinkingFromContext(bool value) { (void)value; }
  /// Whether this driver slides its KV-cache window during generation when
  /// the per-slot context fills. Text drivers slide; multimodal drivers hold
  /// media KV cells fixed and never slide. The scheduler keeps the per-slot
  /// token cap enforced for drivers that cannot slide, since they never
  /// recover a slot that reaches its ceiling.
  [[nodiscard]] virtual bool supportsSliding() const = 0;

  /// Reject prompts that violate per-sequence admission policy (size,
  /// layout, KV-cache state). Called once per `submit` before any state
  /// is mutated; a thrown `StatusError` aborts admission cleanly.
  virtual void validatePromptPolicy(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, const PromptLayout& layout,
      bool hasKvCacheContext) const = 0;

  /// Tokenize the prompt and stage it for prefill (without running
  /// generation). Returns the text tokens still pending decode by the
  /// scheduler at admission time plus any media barriers interleaved
  /// into that stream. `media` carries the raw inline byte payloads and
  /// `mediaPlan` the ordered media markers (byte buffers and paths interleaved
  /// in prompt order); the driver loads them via `computeMediaLoadOrder` so
  /// each bitmap binds to its marker. Text-only drivers must reject a
  /// non-empty `media` or `mediaPlan`.
  virtual PrefillPlan preparePrefill(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools,
      const std::vector<std::vector<uint8_t>>& media,
      const std::vector<PlannedMedia>& mediaPlan, bool isCacheLoaded,
      bool isPrefillOnlyRequest) = 0;

  /// Evaluate the staged media segment `mediaIndex` (an image/audio
  /// chunk produced by `preparePrefill`) at absolute position `pos` for
  /// this driver's sequence. Runs its own `llama_decode` internally
  /// (embedding batch), so the scheduler must NOT hold a batch in
  /// flight. Returns the new position past the segment. Text-only drivers
  /// stage no media barriers, so the default rejects any such call.
  virtual llama_pos evalMediaSegment(size_t mediaIndex, llama_pos pos) {
    (void)mediaIndex;
    (void)pos;
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InternalError),
        "SequenceDriver::evalMediaSegment: driver stages no media segments");
  }

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

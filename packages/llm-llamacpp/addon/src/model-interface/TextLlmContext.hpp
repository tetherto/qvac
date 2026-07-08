#pragma once

#include <atomic>
#include <optional>
#include <utility>
#include <vector>

#include <llama.h>

#include "../utils/ChatTemplateUtils.hpp"
#include "../utils/ReasoningRollbackState.hpp"
#include "../utils/ReasoningUtils.hpp"
#include "../utils/RecurrentStateSnapshot.hpp"
#include "../utils/UTF8TokenBuffer.hpp"
#include "ContextShifter.hpp"
#include "LlmContext.hpp"
#include "ReasoningBlockCompactor.hpp"
#include "SequenceDriver.hpp"
#include "ToolsCompactController.hpp"
#include "common/common.h"
#include "inference-addon-cpp/Logger.hpp"

/// Concrete text-only LLM context. Implements both the legacy
/// `LlmContext` API (driven by the single-prompt path in `LlamaModel`)
/// and the per-sequence `SequenceDriver` API (driven by the
/// `ContinuousBatchScheduler`). The overlapping state-query methods
/// (`getNPast`, `getNSlides`, `validatePromptPolicy`) appear on both
/// bases; a single override below satisfies both vtables.
class TextLlmContext : public LlmContext, public SequenceDriver {
public:
  TextLlmContext(const TextLlmContext&) = delete;
  TextLlmContext& operator=(const TextLlmContext&) = delete;
  TextLlmContext(TextLlmContext&&) = delete;
  TextLlmContext& operator=(TextLlmContext&&) = delete;
  // Constructor
  TextLlmContext(
      common_params& commonParams, common_init_result_ptr llamaInit,
      ToolsCompactController& tools);
  TextLlmContext(
      const common_params& commonParams, const LlmModelContext& shared,
      ToolsCompactController& tools, llama_seq_id seqId,
      llama_pos perSeqCtxCeiling = -1);

  // Destructor
  ~TextLlmContext() override = default;

  /**
   * The eval message method. It evaluates the message and updates the context.
   *
   * @param chatMsgs - chat messages.
   * @param is_cache_loaded - whether the cache is loaded.
   * @param prefill - whether to only prefill context without generation setup.
   * @return - eval result (success / cancellation / rollback status).
   */
  EvalMessageResult evalMessage(
      const std::vector<common_chat_msg>& chatMsgs, bool isCacheLoaded,
      bool prefill) override;

  /**
   * The eval message with tools method. It evaluates the message with tools and
   * updates the context.
   *
   * @param chatMsgs - chat messages.
   * @param tools - tools.
   * @param isCacheLoaded - whether the cache is loaded.
   * @param prefill - whether to only prefill context without generation setup.
   * @return - eval result (success / cancellation / rollback status).
   */
  EvalMessageResult evalMessageWithTools(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
      bool prefill) override;

  /**
   * The generate response method. It generates the response token by token.
   *
   * @param output_callback - the output callback.
   * @return - generation result (success / cancellation / rollback status).
   */
  GenerateResponseResult generateResponse(
      const std::function<void(const std::string&)>& outputCallback) override;

  std::function<void()>
  applyGenerationParams(const GenerationParams& overrides) override;

  /**
   * The stop method. It stops the model inference.
   */
  void stop() override;

  /**
   * The get context method. It returns the context.
   *
   * @return - the context.
   */
  llama_context* getCtx() override;

  /**
   * Access the underlying llama model pointer.
   */
  llama_model* getModel() override { return modelCtx_.model; }

  /**
   * Access the mutable common parameters associated with this context.
   */
  common_params& getParams() override { return params_; }

  /**
   * The get n_past method. It returns the n_past.
   *
   * @return - the n_past.
   */
  [[nodiscard]] llama_pos getNPast() const override;

  /**
   * The set n_past method. It sets the n_past.
   *
   * @param n_past - the n_past.
   */
  void setNPast(llama_pos nPast) override;

  /**
   * The get first msg tokens method. It returns the first msg tokens.
   *
   * @return - the first msg tokens.
   */
  [[nodiscard]] llama_pos getFirstMsgTokens() const override;

  /**
   * The set first msg tokens method. It sets the first msg tokens.
   *
   * @param first_msg_tokens - the first msg tokens.
   */
  void setFirstMsgTokens(llama_pos firstMsgTokens) override;
  /**
   * The set n_discarded method. It sets the n_discarded.
   *
   * @param nDiscarded - the number of tokens to discard.
   */
  void setNDiscarded(llama_pos nDiscarded) override;

  /**
   * The get n_discarded method. It returns the configured context-shift
   * discard budget. A value of 0 means context shifting is disabled.
   *
   * @return - the number of tokens to discard on overflow.
   */
  [[nodiscard]] llama_pos getNDiscarded() const;

  [[nodiscard]] int32_t getNSlides() const override;
  void resetNSlides() override;

  [[nodiscard]] int32_t getThinkingBlockDiscards() const override;
  void resetThinkingBlockDiscards() override;

  [[nodiscard]] std::optional<llama_perf_context_data>
  takeUserVisiblePerfSnapshot() override;

  void setRemoveThinkingFromContext(bool value) override;

  [[nodiscard]] bool supportsSliding() const override { return true; }

  /**
   * The reset state method. It resets the context.
   *
   * @param resetStats - whether to reset performance statistics
   */
  void resetState(bool resetStats) override;

  /**
   * Remove the last N tokens from the model context.
   * This decrements n_past and removes the tokens from the KV cache.
   *
   * @param count - the number of tokens to remove
   * @return the actual number of tokens removed (may be less than requested if
   * not enough tokens exist)
   */
  llama_pos removeLastNTokens(llama_pos count) override;

  PrefillPlan preparePrefill(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools,
      const std::vector<std::vector<uint8_t>>& media,
      const std::vector<PlannedMedia>& mediaPlan, bool isCacheLoaded,
      bool isPrefillOnlyRequest) override;

  void
  onPrefillComplete(llama_pos currentPos, size_t prefillTokenCount) override;

  void syncPosition(llama_pos currentPos) override;

  SequenceStepResult onLogitsReady(
      int logitIdx, unsigned generatedAfterAccept,
      const std::function<void(const std::string&)>& outputCallback,
      LlamaBatch* inlineDecodeBatch = nullptr) override;

  void onSequenceEnd(
      const std::function<void(const std::string&)>& outputCallback) override;

  void onGenerationFinished(
      const std::function<void(const std::string&)>& outputCallback) override;

  [[nodiscard]] bool onCancel(
      const std::function<void(const std::string&)>& outputCallback) override;

  void validatePromptPolicy(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, const PromptLayout& layout,
      bool hasKvCacheContext) const override;

  [[nodiscard]] bool loadCache(
      const std::string& cacheKey, llama_pos configuredNDiscarded) override;
  void saveCache(const std::string& cacheKey) const override;

  void snapshotPreRequestCursor() override;
  void snapshotPreRequestRollbackAnchor() override;

  // Testing seams: expose the owned `ReasoningBlockCompactor` and the
  // otherwise-private `compactThinkSpan()` entry point so driver-level
  // unit tests can install an `IContextSliderOps` override and drive
  // the end-of-generation compaction step directly. Production code
  // MUST NOT use these — production compaction fires from within
  // `onGenerationFinished` / the scheduler's slot cleanup.
  [[nodiscard]] qvac_lib_inference_addon_llama::ReasoningBlockCompactor&
  compactorForTesting() noexcept {
    return compactor_;
  }
  void compactThinkSpanForTesting() { compactThinkSpan(); }
  void seedPrefillEntryRollbackForTesting(llama_pos nPast) noexcept {
    rollbackState_.seedPrefillEntryForTesting(nPast);
  }
  void forcePrefillEntryRestoreFailureForTesting(bool value) noexcept {
    forcePrefillEntryRestoreFailureForTesting_ = value;
  }

private:
  /// Hook fired exactly once per slot, immediately before the policy
  /// flushes its UTF-8 buffer at end-of-generation. Internal helper for
  /// `onGenerationFinished`.
  void onGenerationCompletePolicy(std::string_view assistantOutput);

  /**
   * The check antiprompt method. It checks the antiprompt.
   *
   * @return - true if the antiprompt is found, false otherwise.
   */
  bool checkAntiprompt();

  /**
   * The Tokenize chat method. It tokenizes the chat.
   *
   * @param chatMsgs - chat messages.
   * @param inputTokens - output tokens.
   * @param isCacheLoaded - whether the cache is loaded.
   */
  void tokenizeChat(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools,
      std::vector<llama_token>& inputTokens, bool isCacheLoaded);

  // Replaces an EOS sampled while inside the reasoning channel with the
  // model's single-token close marker and injects the trailing newlines.
  // No-op (returns false) when the close marker is multi-token.
  bool handleReasoningEOS(
      llama_token& tokenId, std::string& tokenStr, llama_batch& batch,
      llama_pos& nPast,
      const std::function<void(const std::string&)>& outputCallback);

  void flushPendingUtf8ToCallback(
      const std::function<void(const std::string&)>& outputCallback);
  void emitOutputPiece(
      const std::function<void(const std::string&)>& outputCallback,
      const std::string& text);
  void initializeCommonState();
  void initializeOwnedThreadpools();
  [[nodiscard]] llama_pos ctxCeiling() const;
  /// Slide the context window if the next token would not fit. Returns
  /// the number of tokens discarded (0 when no slide happened).
  llama_pos applyContextDiscard();

  // Reasoning-block KV-cache compaction helpers. Single-block policy:
  // at most one `<think>...</think>` block is tracked per inference.
  // `setOpenThinkSpan` is a no-op once a span has been captured.
  void setOpenThinkSpan(llama_pos start);
  void capturePendingThinkClose();
  void compactThinkSpan();
  void configureReasoningTags(
      const std::string& thinkingStartTag, const std::string& thinkingEndTag,
      const std::string& forcedOpenText);

  // Delegates to `rollbackState_.recordPostReasoningToken` when the
  // post-reasoning capture phase is active (close marker committed AND
  // a recurrent boundary snapshot exists). No-op for pure-attention
  // models where capture never starts.
  void recordPostReasoningTokenIfActive(llama_token tokenId);

  // Returns the token index in the prefill stream at which we should
  // pause and snapshot the sequence state for the recurrent rollback
  // path. Returns the sentinel `-1` when no snapshot is needed for
  // this inference (memory module supports shift, feature disabled,
  // prefill-only request, or reasoning channel not active). Throws when
  // the feature is enabled for a recurrent / hybrid generation request
  // but the template does not satisfy the snapshot + replay
  // preconditions. Snapshots at END of prefill (boundary ==
  // `prefillLen`); generated opener tokens, when present, are seeded
  // into the replay buffer so the restored recurrent state stays
  // structurally balanced after replay.
  [[nodiscard]] llama_pos
  computeRecurrentSnapshotBoundary(llama_pos prefillLen) const;

  // Takes a full-state snapshot of `seqId_` at the current `nPast_`
  // and stores it in `rollbackState_`. No-op unless recurrent snapshot
  // compaction is relevant for this request. Under the uniform
  // hard-fail contract for `remove_thinking_from_context`, unsupported
  // recurrent template shapes and snapshot capture failures propagate
  // as `qvac_errors::StatusError`; the wrapper restores its pre-prompt
  // checkpoint via `restorePrefillEntry`, resets local positional
  // accounting, and re-throws so no saveCache path can persist a cache
  // whose header no longer matches live memory.
  void snapshotForRecurrentRollback();

  ToolsCompactController& tools_;
  common_init_result_ptr llamaInit_;
  LlmModelContext modelCtx_;
  CommonSamplerPtr smpl_;

  common_params params_;
  common_chat_templates_ptr tmpls_;
  std::vector<llama_token> antipromptTokens_;
  std::vector<llama_token> forcedTokens_;

  llama_pos nPast_ = 0;
  llama_pos firstMsgTokens_ = 0;
  llama_pos perSeqCtxCeiling_ = -1;
  bool forcePrefillEntryRestoreFailureForTesting_ = false;
  // Snapshot of `nPast_` / `firstMsgTokens_` at `evalMessageWithTools`
  // entry. Restored by `onCancel` to roll back to the pre-request cursor.
  llama_pos preRequestNPast_ = 0;
  llama_pos preRequestFirstMsgTokens_ = 0;
  bool pendingBatchFirstMsg_ = false;
  bool generationStarted_ = false;
  std::string assistantOutput_;
  ThreadPoolPtr threadpool_;
  ThreadPoolPtr threadpoolBatch_;

  // UTF-8 token buffer for handling incomplete emoji sequences
  qvac_lib_inference_addon_llama::UTF8TokenBuffer utf8Buffer_;

  // Reasoning channel detection state (Qwen3 / Gemma 4 / ...). Empty
  // tags when the active model has no recognised channel.
  qvac_lib_inference_addon_llama::utils::ReasoningState reasoningState_;
  bool reasoningEnabled_ = false;

  // True only for architectures in the Qwen3 reasoning family (qwen3,
  // qwen3moe, qwen35, qwen35moe). Gates the EOS-inside-reasoning
  // recovery (close-marker substitution + newline injection), which is
  // a Qwen3-specific workaround. Detection / span tracking / KV
  // compaction stay family-agnostic via `reasoningEnabled_`.
  bool isQwen3ReasoningFamily_ = false;

  // GPT-OSS Harmony: <|call|> is a frame delimiter, not a stop signal
  bool isHarmonyModel_ = false;
  llama_token harmonyCallToken_ = LLAMA_TOKEN_NULL;

  // Force-opens the reasoning channel in the prompt suffix. The text mirrors
  // the template-specific visible reasoning opener so consumers see balanced
  // tags.
  bool thinkingForcedOpen_ = false;
  std::string thinkingForcedOpenText_;

  // Per-request toggle for the post-generation thinking-block KV
  // cache compaction. Default-on (opt-out via `generationParams` with
  // `remove_thinking_from_context: false`); set by
  // `applyGenerationParams`. Applies uniformly to pure-attention and
  // recurrent / hybrid-SSM models — the model-type distinction is
  // enforced downstream via `needsRecurrentSnapshot_`, not by varying
  // this default per model.
  bool removeThinkingFromContext_ = true;

  // True when this context's model is recurrent or hybrid
  // (`llama_model_is_recurrent || llama_model_is_hybrid`) — Mamba /
  // RWKV pure-recurrent and hybrid SSM + attention families (Qwen3.5,
  // Qwen3-Next, Jamba, Granite-Hybrid, LFM2, Nemotron-H, Kimi-Linear).
  // For these we use the snapshot + replay path: snapshot the full
  // sequence state at end-of-prefill, restore at end-of-generation,
  // then batched-replay the captured post-reasoning tokens.
  // Pure-attention models keep the existing
  // `seq_rm + seq_add` path untouched.
  bool needsRecurrentSnapshot_ = false;

  // Tracks whether the currently-prepared prefill is a cache-warm
  // (prefill-only) request. Captured in `preparePrefill` from the
  // scheduler / single-prompt caller and consulted by the recurrent
  // reasoning snapshot path: prefill-only requests never enter
  // generation and cannot emit reasoning tokens, so the hard-fail
  // contract for unsupported multi-token recurrent close markers does
  // not apply. Prevents cache-warm calls from failing on models that
  // would only fail at generation time.
  bool isPrefillOnlyRequest_ = false;

  // Shared rollback state for recurrent / hybrid SSM models. Owns the
  // prefill-entry snapshot (cancel during prefill), the end-of-prefill
  // snapshot (compaction + cancel during generation), and the
  // post-reasoning token replay buffer. Always empty / inactive on
  // pure-attention models, where compaction is just `seq_rm + seq_add`
  // on the attention KV.
  qvac_lib_inference_addon_llama::utils::ReasoningRollbackState rollbackState_;
  // Reasoning-block tracker + compactor: owns the `<think>...</think>`
  // span, close-capture flag, and the pure-attention + recurrent
  // compaction paths plus their stats counters.
  qvac_lib_inference_addon_llama::ReasoningBlockCompactor compactor_;
  // Context-window slider: owns `nDiscarded`, `nSlides`, and clears
  // post-slide-invalidated state on the compactor and rollback owners.
  qvac_lib_inference_addon_llama::ContextShifter shifter_;

  // Snapshot of `llama_perf_context()` taken at the start of
  // `compactThinkSpan` — i.e. right after user-visible generation
  // completes and before any recurrent replay decode runs. Consumed by
  // `runtimeStats()` via `takeUserVisiblePerfSnapshot()` so the replay's
  // `llama_decode` calls (which accumulate into `n_p_eval` /
  // `t_p_eval_ms`) do not inflate user-facing prompt / TTFT / ppTPS.
  // Reset at the start of each inference and on `resetState`.
  std::optional<llama_perf_context_data> userVisiblePerf_;

  std::atomic<bool> stopGeneration_ = false;
};

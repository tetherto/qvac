#pragma once

#include <atomic>
#include <optional>
#include <utility>
#include <vector>

#include <llama-cpp.h>
#include <llama.h>

#include "../utils/ChatTemplateUtils.hpp"
#include "../utils/ReasoningRollbackState.hpp"
#include "../utils/ReasoningUtils.hpp"
#include "../utils/RecurrentStateSnapshot.hpp"
#include "../utils/UTF8TokenBuffer.hpp"
#include "LlmContext.hpp"
#include "ReasoningBlockCompactor.hpp"
#include "SequenceDriver.hpp"
#include "common/common.h"
#include "common/speculative.h"
#include "inference-addon-cpp/Logger.hpp"

/// Concrete text-only LLM context. Implements both the legacy
/// `LlmContext` API (driven by the single-prompt path in `LlamaModel`)
/// and the per-sequence `SequenceDriver` API (driven by the
/// `ContinuousBatchScheduler`). The overlapping state-query methods
/// (`getNPast`) appear on both
/// bases; a single override below satisfies both vtables.
class TextLlmContext : public LlmContext, public SequenceDriver {
  friend class TextLlmContextTestPeer;

public:
  TextLlmContext(const TextLlmContext&) = delete;
  TextLlmContext& operator=(const TextLlmContext&) = delete;
  TextLlmContext(TextLlmContext&&) = delete;
  TextLlmContext& operator=(TextLlmContext&&) = delete;
  // Constructor
  TextLlmContext(common_params& commonParams, common_init_result_ptr llamaInit);
  TextLlmContext(
      const common_params& commonParams, const LlmModelContext& shared,
      llama_seq_id seqId, llama_pos perSeqCtxCeiling = -1);

  // Destructor
  ~TextLlmContext() override;

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

  void resetStopFlag() override;

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

  [[nodiscard]] int32_t getThinkingBlockDiscards() const override;
  void resetThinkingBlockDiscards() override;

  [[nodiscard]] int32_t getToolDefinitionsDropped() const override;
  void resetToolDefinitionsDropped() override;

  void setRenderOverrides(RenderOverrides overrides) override {
    renderOverrides_ = std::move(overrides);
  }

  [[nodiscard]] GenerationStopReason getGenerationStopReason() const override {
    return generationStopReason_;
  }

  [[nodiscard]] std::optional<llama_perf_context_data>
  takeUserVisiblePerfSnapshot() override;

  void setRemoveThinkingFromContext(bool value) override;

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

  [[nodiscard]] bool onGenerationFinished(
      const std::function<void(const std::string&)>& outputCallback,
      GenerationStopReason terminalReason =
          GenerationStopReason::None) override;

  [[nodiscard]] bool onCancel(
      const std::function<void(const std::string&)>& outputCallback) override;

  [[nodiscard]] bool loadCache(const std::string& cacheKey) override;
  void saveCache(const std::string& cacheKey) const override;

  void snapshotPreRequestCursor() override;
  void snapshotPreRequestRollbackAnchor() override;

  // Testing seams: expose the owned `ReasoningBlockCompactor` and the
  // otherwise-private `compactThinkSpan()` entry point so driver-level
  // unit tests can install an `IReasoningRewindOps` override and drive
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
  /// Replaces the next token this context samples *while the reasoning block
  /// is open*, before the sampler accepts it. Two reasons for that shape:
  /// the EOS-inside-reasoning recovery only triggers on a genuinely sampled
  /// EOS, so `forcedTokens_` cannot reach it (that queue marks a token as not
  /// sampled by construction); and no template this package ships force-opens
  /// the channel, so a substitution on the first sample would land before the
  /// block exists. Consumed by the first qualifying sample after the call.
  void
  forceNextSampledTokenInsideReasoningForTesting(llama_token token) noexcept {
    forcedNextSampledTokenForTesting_ = token;
  }
  /// Forces this context's tools-dropped count, so a test can give a slot a
  /// known value without needing a chat template that actually rejects tool
  /// definitions — unreachable through the addon's config, since fabric
  /// defaults `use_jinja` to true and `--chat-template` is not registered for
  /// `LLAMA_EXAMPLE_COMMON`. Used to prove the count is reported per request
  /// rather than aggregated across concurrent ones.
  void forceToolDefinitionsDroppedForTesting(int32_t value) noexcept {
    toolDefinitionsDropped_ = value;
  }
  /// The live sampler, for tests that have to probe fabric-side sampler state
  /// no field on this class mirrors — the reasoning-budget matcher's, in
  /// particular. Null when a failed restore left the context without one.
  [[nodiscard]] common_sampler* samplerForTesting() const noexcept {
    return smpl_.get();
  }

private:
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

  // Ensures `smpl_` is non-null, which a failed per-request restore can leave
  // it. Attempts one rebuild from the current sampling params and throws if
  // that fails too. Called at request entry so the failure is a StatusError
  // rather than a null dereference inside fabric's sampler.
  void requireSampler();

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

  // Reasoning-block KV-cache compaction helpers. Single-block policy:
  // at most one `<think>...</think>` block is tracked per inference.
  // `setOpenThinkSpan` is a no-op once a span has been captured.
  void setOpenThinkSpan(llama_pos start);
  void capturePendingThinkClose();
  void compactThinkSpan();
  [[nodiscard]] bool shouldRollbackInterruptedReasoning() const;
  [[nodiscard]] bool rollbackCurrentRequest(
      const std::function<void(const std::string&)>& outputCallback);
  // `fallbackTags` is the model-family reasoning channel, resolved by the
  // caller so `configureTemplateDerivedSampling` can build the
  // reasoning-budget markers from the same value.
  void configureReasoningTags(
      const std::string& thinkingStartTag, const std::string& thinkingEndTag,
      const std::string& forcedOpenText,
      const std::optional<qvac_lib_inference_addon_llama::utils::ReasoningTags>&
          fallbackTags);

  // Delegates to `rollbackState_.recordPostReasoningToken` while the
  // post-reasoning capture phase is active, which starts once the close
  // marker is committed. Every model kind anchors a boundary, so this runs
  // on pure attention too; it is a no-op only when the feature is off.
  void recordPostReasoningTokenIfActive(llama_token tokenId);

  // Token index in the prefill stream where the decode must stop so the
  // full-state snapshot is taken before a force-open template's `<think>`
  // opener. The sentinel `-1` means no stop: the feature is off, the
  // reasoning channel is inactive, this is a prefill-only request, or the
  // model is pure attention, whose anchor is an absolute position that needs
  // no decode stop. A generated-opener template has nothing in the prompt to
  // stop before, so its boundary is the end of prefill and `compact()` clips
  // the sampled opener pieces out of the replay instead.
  [[nodiscard]] llama_pos
  computeRecurrentSnapshotBoundary(llama_pos prefillLen) const;

  // Anchors the compaction boundary at the current `nPast_`: a full-state
  // snapshot on recurrent / hybrid, a bare position on pure attention. No-op
  // unless compaction is relevant for this request. Under the uniform
  // hard-fail contract for `remove_thinking_from_context`, a capture failure
  // propagates as `qvac_errors::StatusError`; the wrapper restores its
  // pre-prompt
  // checkpoint via `restorePrefillEntry`, resets local positional
  // accounting, and re-throws so no saveCache path can persist a cache
  // whose header no longer matches live memory.
  void snapshotForRecurrentRollback();

  /// Boundary capture plus the hard-fail rollback that guards it, split out
  /// of `snapshotForRecurrentRollback` so the unwind path stays readable.
  void captureReasoningBoundaryAt(llama_pos anchorPos);

  // Hooks for the shared MTP loop in `LlmContext`.
  void specBeginGeneration(
      const std::function<void(const std::string&)>& outputCallback) override;
  [[nodiscard]] llama_pos specPos() const override { return nPast_; }
  void specSetPos(llama_pos pos) override { nPast_ = pos; }
  [[nodiscard]] llama_pos specCtxCeiling() const override {
    return ctxCeiling();
  }
  // handleReasoningEOS commits the close marker, and the 2 newlines only when
  // the vocab actually yielded a single-token newline (ReasoningUtils leaves
  // `cached_newline_token` null otherwise). Reporting a flat 3 on a model
  // without one refuses recoveries that would have fit -- the same
  // over-reservation MtmdLlmContext already overrides away.
  [[nodiscard]] llama_pos specRecoveryPositions() const override {
    return reasoningState_.cached_newline_token == LLAMA_TOKEN_NULL ? 1 : 3;
  }
  llama_token specSampleFirstToken(bool& sampled) override {
    return sampleToken(-1, sampled);
  }
  llama_token specSampleAndAccept(int logitIdx) override {
    // Honor a pending post-reasoning-recovery EOG ban on the speculative path.
    // This sampler bypasses sampleToken() — the normal path's ban consumer — so
    // without this a Qwen3 reasoning model that emitted EOS *inside* <think>
    // could immediately sample EOS again here -> empty answer (the ban exists
    // to prevent exactly that on the non-spec path). The flag is armed by
    // handleReasoningEOS()/specRecoverReasoning() and is consumed once here.
    applyPendingEogBan(logitIdx);
    const llama_token tok =
        common_sampler_sample(smpl_.get(), modelCtx_.lctx, logitIdx);
    common_sampler_accept(smpl_.get(), tok, true);
    return tok;
  }
  SequenceStepResult specProcessToken(
      llama_token tokenId, bool sampled, unsigned generated,
      const std::function<void(const std::string&)>& outputCallback,
      LlamaBatch* inlineDecodeBatch) override {
    return processToken(
        tokenId, sampled, generated, outputCallback, inlineDecodeBatch);
  }
  bool specShouldRecoverReasoning(llama_token tok) override {
    return llama_vocab_is_eog(modelCtx_.vocab, tok) &&
           isQwen3ReasoningFamily_ && reasoningState_.inside_reasoning &&
           reasoningState_.cached_close_tag_token != LLAMA_TOKEN_NULL;
  }
  void specRecoverReasoning(
      llama_token tok, LlamaBatch& batch,
      const std::function<void(const std::string&)>& outputCallback) override {
    llama_token closeTok = tok;
    std::string closeStr;
    handleReasoningEOS(closeTok, closeStr, *batch, nPast_, outputCallback);
  }
  GenerateResponseResult specFinish(
      const std::function<void(const std::string&)>& outputCallback,
      bool ok) override {
    // A natural (ok) end of the speculative loop is a prediction-limit stop.
    // This MUST be set before onGenerationFinished: that call feeds
    // generationStopReason_ into shouldRollbackKnownReasoningCutoff(), which
    // drops an unbalanced <think> span from the (recurrent/hybrid) KV cache
    // only when the reason is PredictionLimit/SequenceLimit. Leaving it None
    // here (the non-spec reset at generateResponse sits after the spec branch,
    // so it never runs for MTP) would skip that rollback and corrupt later
    // turns. Mirrors MtmdLlmContext::specFinish. Also propagate rollbackOk
    // (nodiscard).
    if (generationStopReason_ == GenerationStopReason::None) {
      // ok=false is only reached from the context-ceiling bail-outs, so report
      // ContextOverflow there rather than leaving the reason unset (matches the
      // non-speculative paths, which set it explicitly).
      generationStopReason_ = ok ? GenerationStopReason::PredictionLimit
                                 : GenerationStopReason::ContextOverflow;
    }
    const bool rollbackOk =
        onGenerationFinished(outputCallback, generationStopReason_);
    // Like the non-speculative loop, filling the context during generation is
    // a successful terminal outcome. `ok=false` here classifies that outcome;
    // it must not turn it into the prompt-admission exception handled by
    // LlamaModel::processPromptImpl.
    return {.ok = true, .rollbackOk = rollbackOk};
  }
  GenerateResponseResult specCancel(
      const std::function<void(const std::string&)>& outputCallback) override {
    return {
        .ok = true, .cancelled = true, .rollbackOk = onCancel(outputCallback)};
  }

  // Consume a pending post-reasoning-recovery EOG ban: if
  // `banEogAfterReasoningRecovery_` is armed, mask every end-of-generation
  // token
  // (`eogTokens_`) in the logits at `logitIdx` for exactly this one sample,
  // then disarm. Shared by the normal (`sampleToken`) and speculative
  // (`specSampleAndAccept`) sampling paths so both honor the ban.
  void applyPendingEogBan(int logitIdx);

  // Sample token from the logits at logitIdx. Extracted from
  // onLogitsReady so the speculative path, which obtains its tokens from
  // common_sampler_sample_and_accept_n, can reuse the per-token post-processing
  // in processToken without re-sampling.
  llama_token sampleToken(int logitIdx, bool& sampledOut);

  // Post-process a single already-decided token. Shared by the
  // normal per-token path and the speculative accept loop.
  SequenceStepResult processToken(
      llama_token tokenId, bool sampled, unsigned generatedAfterAccept,
      const std::function<void(const std::string&)>& outputCallback,
      LlamaBatch* inlineDecodeBatch);

  common_init_result_ptr llamaInit_;
  LlmModelContext modelCtx_;
  CommonSamplerPtr smpl_;

  common_params params_;
  common_chat_templates_ptr tmpls_;
  std::vector<llama_token> antipromptTokens_;
  // Per-request stop strings supplied by the chat template
  // (`common_chat_params::additional_stops`). Refreshed on every
  // `tokenizeChat`, unlike the load-time `params_.antiprompt`.
  std::vector<std::string> templateStops_;
  std::vector<llama_token> templateStopTokens_;
  // Lowercased copy of the caller-supplied antiprompts only. Those match
  // case-insensitively and are constant for a whole generation, so the fold is
  // done once rather than in `checkAntiprompt`'s per-token scan. There is
  // deliberately no twin for `templateStops_`: template delimiters match
  // byte-for-byte (see `utils::matchesAnyStopString`).
  std::vector<std::string> antipromptLower_;
  // Renders in the current request where the template dropped the tools.
  int32_t toolDefinitionsDropped_ = 0;
  // Per-request `tool_choice` for the chat-template render.
  RenderOverrides renderOverrides_;
  std::vector<llama_token> forcedTokens_;

  llama_pos nPast_ = 0;
  llama_pos perSeqCtxCeiling_ = -1;
  bool forcePrefillEntryRestoreFailureForTesting_ = false;
  llama_token forcedNextSampledTokenForTesting_ = LLAMA_TOKEN_NULL;
  // Snapshot of `nPast_` at `evalMessageWithTools` entry. Restored by
  // `onCancel` to roll back to the pre-request cursor.
  llama_pos preRequestNPast_ = 0;
  GenerationStopReason generationStopReason_ = GenerationStopReason::None;
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

  // EOS-inside-reasoning recovery: the recovery substitutes `</think>\n\n` so
  // the model produces an answer after thinking, but on marginal prompts the
  // very next sampled token is EOG again, which would defeat the recovery
  // with an empty answer. One-shot: consumed by the next sampled token.
  // Narrowed vs the original (reverted in 39a2fef88) fix: all EOG ids are
  // banned in a single pre-sampling pass (no sample-and-reroll loop). The
  // ban is unconditional — the generation loop only calls onLogitsReady()
  // while the n_predict budget allows the current token, so banning EOG on
  // the final budgeted sample yields a content token without ever
  // extending generation past the budget.
  bool banEogAfterReasoningRecovery_ = false;

  // All EOG token ids of the loaded vocab, precomputed once in
  // initializeCommonState() (Qwen3 family only) so the recovery ban is one
  // pass over a short list with no mid-stream O(nVocab) scan.
  std::vector<llama_token> eogTokens_;

  // GPT-OSS Harmony: <|call|> is a frame delimiter, not a stop signal
  bool isHarmonyModel_ = false;
  llama_token harmonyCallToken_ = LLAMA_TOKEN_NULL;

  // Force-opens the reasoning channel in the prompt suffix. The text mirrors
  // the template-specific visible reasoning opener so consumers see balanced
  // tags.
  bool thinkingForcedOpen_ = false;
  std::string thinkingForcedOpenText_;

  // Per-request toggle for post-generation thinking-block KV compaction.
  // Default-off, except Qwen3-family models opt in during initialization;
  // `generationParams` can always override it.
  bool removeThinkingFromContext_ = false;

  // True when this context's model is recurrent, hybrid, or DeepSeek V4.
  // (`llama_model_is_recurrent || llama_model_is_hybrid`) — Mamba /
  // RWKV pure-recurrent and hybrid SSM + attention families (Qwen3.5,
  // Qwen3-Next, Jamba, Granite-Hybrid, LFM2, Nemotron-H, Kimi-Linear).
  // For these we use the snapshot + replay path: snapshot the full
  // DeepSeek V4 has the same checkpoint requirement despite not reporting
  // either predicate. We snapshot the full sequence state at the reasoning
  // boundary, restore at end-of-generation,
  // then batched-replay the captured post-reasoning tokens. Pure-attention
  // models replay too; they anchor a position instead of a state payload,
  // because rewinding positionally indexed cells is a tail trim.
  bool needsRecurrentSnapshot_ = false;

  // Tracks whether the currently-prepared prefill is a cache-warm
  // (prefill-only) request. Captured in `preparePrefill` from the
  // scheduler / single-prompt caller and consulted by the recurrent
  // reasoning snapshot path: prefill-only requests never enter
  // generation and cannot emit reasoning tokens, so there is no
  // reasoning boundary to anchor. Prevents cache-warm calls from
  // failing on models whose boundary capture would only be exercised
  // at generation time.
  bool isPrefillOnlyRequest_ = false;

  // Shared rollback state for recurrent / hybrid SSM models. Owns the
  // prefill-entry snapshot (cancel during prefill), the reasoning-boundary
  // snapshot (compaction + cancel during generation), and the
  // post-reasoning token replay buffer. Populated on every model now; on
  // pure attention the boundary is a position rather than a state payload.
  qvac_lib_inference_addon_llama::utils::ReasoningRollbackState rollbackState_;
  // Reasoning-block tracker + compactor: owns the `<think>...</think>`
  // span, close-capture flag, and the pure-attention + recurrent
  // compaction paths plus their stats counters.
  qvac_lib_inference_addon_llama::ReasoningBlockCompactor compactor_;

  // Snapshot of `llama_perf_context()` taken at the start of
  // `compactThinkSpan` — i.e. right after user-visible generation
  // completes and before any replay decode runs. Consumed by
  // `runtimeStats()` via `takeUserVisiblePerfSnapshot()` so the replay's
  // `llama_decode` calls (which accumulate into `n_p_eval` /
  // `t_p_eval_ms`) do not inflate user-facing prompt / TTFT / ppTPS.
  // Reset at the start of each inference and on `resetState`.
  std::optional<llama_perf_context_data> userVisiblePerf_;
};

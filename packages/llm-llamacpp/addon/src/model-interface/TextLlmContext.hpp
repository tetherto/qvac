#pragma once

#include <atomic>
#include <deque>
#include <optional>
#include <utility>
#include <vector>

#include <llama.h>

#include "../utils/ChatTemplateUtils.hpp"
#include "../utils/ReasoningUtils.hpp"
#include "../utils/RequestRollbackState.hpp"
#include "../utils/SequenceStateSnapshot.hpp"
#include "../utils/UTF8TokenBuffer.hpp"
#include "LlmContext.hpp"
#include "SequenceDriver.hpp"
#include "common/common.h"
#include "inference-addon-cpp/Logger.hpp"

/// Concrete text-only LLM context. Implements both the legacy
/// `LlmContext` API (driven by the single-prompt path in `LlamaModel`)
/// and the per-sequence `SequenceDriver` API (driven by the
/// `ContinuousBatchScheduler`). The overlapping state-query methods
/// (`getNPast`) appear on both
/// bases; a single override below satisfies both vtables.
class TextLlmContext : public LlmContext, public SequenceDriver {
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

  [[nodiscard]] int32_t getToolDefinitionsDropped() const override;
  void resetToolDefinitionsDropped() override;

  void setRenderOverrides(RenderOverrides overrides) override {
    renderOverrides_ = std::move(overrides);
  }

  [[nodiscard]] GenerationStopReason getGenerationStopReason() const override {
    return generationStopReason_;
  }

  void setCacheReconciliationEnabled(bool enabled) override {
    cacheReconciliationEnabled_ = enabled;
  }
  void setCacheCheckpointPolicy(
      const qvac_lib_inference_addon_llama::cache::CheckpointPolicy& policy)
      override {
    cacheCheckpointPolicy_ = policy;
    requestRollback_.setStorage(policy.storage);
  }
  [[nodiscard]] std::vector<llama_token> cacheStateTokens() const override;
  void restoreCacheStateTokens(const std::vector<llama_token>& tokens) override;
  void clearCacheReconciliationState() override;
  [[nodiscard]] bool rollbackFailedRequest() override;
  [[nodiscard]] bool shouldPersistAfterFinalize() const override {
    return !cacheRequestRolledBack_;
  }

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
  [[nodiscard]] bool onFailure(
      const std::function<void(const std::string&)>& outputCallback) override;

  [[nodiscard]] bool loadCache(const std::string& cacheKey) override;
  void saveCache(const std::string& cacheKey) const override;

  void snapshotPreRequestCursor() override;
  void snapshotPreRequestRollbackAnchor() override;

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
  /// Makes the next synthetic reasoning-recovery decode fail before it reaches
  /// llama.cpp. Used to verify that the request transaction rolls back instead
  /// of committing a partially injected close sequence.
  void forceReasoningRecoveryDecodeFailureForTesting() noexcept {
    forceReasoningRecoveryDecodeFailureForTesting_ = true;
  }
  /// True while the active cache request holds a pre-request full-state
  /// dump. Lets tests prove pure-attention append-only requests never write
  /// one and roll back with a tail trim instead.
  [[nodiscard]] bool hasPreRequestCacheSnapshotForTesting() const noexcept {
    return !preRequestCacheSnapshot_.empty();
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

  // Reasoning-channel tracking is retained for output parsing and stop
  // handling. Generated reasoning stays resident until the next complete
  // prompt is reconciled against the cache ledger.
  [[nodiscard]] bool rollbackCurrentRequest(
      const std::function<void(const std::string&)>& outputCallback);
  // Cancel after prefill completed: keep the prompt and streamed tokens
  // resident (and commit the cache transaction when one is active).
  [[nodiscard]] bool commitCancelledRequest(
      const std::function<void(const std::string&)>& outputCallback);
  // `fallbackTags` is the model-family reasoning channel, resolved by the
  // caller so `configureTemplateDerivedSampling` can build the
  // reasoning-budget markers from the same value.
  void configureReasoningTags(
      const std::string& thinkingStartTag, const std::string& thinkingEndTag,
      const std::optional<qvac_lib_inference_addon_llama::utils::ReasoningTags>&
          fallbackTags);

  struct CacheCheckpoint {
    qvac_lib_inference_addon_llama::utils::SequenceStateSnapshot state;
    qvac_lib_inference_addon_llama::cache::Ledger ledger;
  };
  void beginCacheRequest();
  void capturePreRequestCacheSnapshot();
  std::vector<llama_token> reconcilePrompt(
      const std::vector<llama_token>& fullPrompt, bool isPrefillOnlyRequest);
  void rebuildSamplerFromLedger(
      const qvac_lib_inference_addon_llama::cache::Ledger& ledger);
  void commitCacheRequest();
  bool restorePreRequestCacheState();
  void appendResidentToken(llama_token token);

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
  llama_token forcedNextSampledTokenForTesting_ = LLAMA_TOKEN_NULL;
  bool forceReasoningRecoveryDecodeFailureForTesting_ = false;
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
  // a Qwen3-specific workaround.
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

  bool cacheReconciliationEnabled_ = false;
  bool cacheRequestActive_ = false;
  bool cacheRequestRolledBack_ = false;
  // Request phase, reset at `preparePrefill` and set by `onPrefillComplete`.
  // A cancel before it rolls the request back to the pre-request state; a
  // cancel after it keeps the prompt and streamed tokens, cached or not.
  bool prefillComplete_ = false;
  qvac_lib_inference_addon_llama::cache::Ledger residentLedger_;
  qvac_lib_inference_addon_llama::cache::Ledger pendingPromptLedger_;
  qvac_lib_inference_addon_llama::cache::Ledger preRequestLedger_;
  qvac_lib_inference_addon_llama::utils::SequenceStateSnapshot
      preRequestCacheSnapshot_;
  std::deque<CacheCheckpoint> cacheCheckpoints_;
  qvac_lib_inference_addon_llama::cache::CheckpointPolicy
      cacheCheckpointPolicy_;

  // True when this context's model needs full-state snapshots for request
  // rollback and divergent-history checkpoints because arbitrary tail
  // removal is unsafe. Decided once by `needsFullStateSnapshot` in
  // ModelMemoryPolicy.hpp (recurrent, hybrid, DeepSeek V4, ...); every
  // non-standard memory layout must be added there, not at call sites.
  bool needsFullStateSnapshot_ = false;

  // Tracks whether the current request is prefill-only so the cache
  // transaction can commit immediately after successful prefill.
  bool isPrefillOnlyRequest_ = false;

  // Generic request-entry snapshot for cancellation on memory that cannot
  // remove an arbitrary decoded tail.
  qvac_lib_inference_addon_llama::utils::RequestRollbackState requestRollback_;

  std::atomic<bool> stopGeneration_ = false;
};

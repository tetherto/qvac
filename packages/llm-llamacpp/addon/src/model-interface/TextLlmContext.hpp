#pragma once

#include <atomic>
#include <optional>
#include <utility>
#include <vector>

#include <llama.h>

#include "../utils/ChatTemplateUtils.hpp"
#include "../utils/ReasoningUtils.hpp"
#include "../utils/UTF8TokenBuffer.hpp"
#include "LlmContext.hpp"
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
   * @return - true if successful, false if inference is stopped.
   */
  bool evalMessage(
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
   * @return - true if successful, false if inference is stopped.
   */
  bool evalMessageWithTools(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
      bool prefill) override;

  /**
   * The generate response method. It generates the response token by token.
   *
   * @param output_callback - the output callback.
   * @return - true if successful, false if context overflow.
   */
  bool generateResponse(
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

  std::vector<llama_token> preparePrefill(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
      bool prefill) override;

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

  void onCancel(
      const std::function<void(const std::string&)>& outputCallback) override;

  void validatePromptPolicy(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, const PromptLayout& layout,
      bool hasKvCacheContext) const override;

  [[nodiscard]] bool loadCache(
      const std::string& cacheKey, llama_pos configuredNDiscarded) override;
  void saveCache(const std::string& cacheKey) const override;

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
  void handleStopRequestAndAddEot(LlamaBatch& batch);

  // Reasoning-block KV-cache compaction helpers. Single-block policy:
  // at most one `<think>...</think>` block is tracked per inference.
  // `setOpenThinkSpan` is a no-op once a span has been captured.
  void setOpenThinkSpan(llama_pos start);
  void capturePendingThinkClose();
  void compactThinkSpan();
  void configureReasoningTags(
      const std::string& thinkingStartTag, const std::string& thinkingEndTag,
      const std::string& forcedOpenText);

  ToolsCompactController& tools_;
  common_init_result_ptr llamaInit_;
  LlmModelContext modelCtx_;
  CommonSamplerPtr smpl_;

  common_params params_;
  common_chat_templates_ptr tmpls_;
  std::vector<llama_token> antipromptTokens_;
  std::vector<llama_token> forcedTokens_;

  llama_pos nPast_ = 0;
  llama_pos nDiscarded_ = 0;
  llama_pos firstMsgTokens_ = 0;
  llama_pos perSeqCtxCeiling_ = -1;
  int32_t nSlides_ = 0;
  int32_t thinkingBlockDiscards_ = 0;
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
  // cache compaction. Default-off (opt-in via `generationParams`); set
  // by `applyGenerationParams`.
  bool removeThinkingFromContext_ = false;

  // True when the model uses recurrent memory (Mamba-style SSM layers
  // or hybrid SSM + attention like Qwen3.5). Detected at construction
  // via `llama_model_is_recurrent` plus an `<arch>.ssm.*` metadata
  // probe. `setRemoveThinkingFromContext(true)` throws when this is
  // true — `seq_rm + seq_add` succeeds on the attention KV but the SSM
  // hidden state still carries the dropped tokens, so subsequent turns
  // read contaminated state. Pure-attention models (Qwen3, Qwen3-MoE,
  // Gemma 4, ...) are unaffected.
  bool hasRecurrentMemory_ = false;

  // [start, end) KV positions of the reasoning block emitted in this
  // inference, if any. `end == -1` marks an open (still-being-emitted)
  // span. Single-block policy: only the first `<think>...</think>` pair
  // is tracked; later blocks (which no supported model currently emits)
  // are ignored.
  std::optional<std::pair<llama_pos, llama_pos>> thinkSpan_;
  // True when the close marker was detected but its token has not yet
  // been committed to the KV cache; the next `onLogitsReady` records
  // the end position once the commit has happened.
  bool pendingThinkCloseCapture_ = false;

  std::atomic<bool> stopGeneration_ = false;
};

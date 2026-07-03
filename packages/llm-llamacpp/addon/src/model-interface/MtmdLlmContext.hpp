#pragma once

#include <atomic>
#include <optional>

#include <llama.h>
#include <llama/mtmd/mtmd.h>

#include "../utils/ReasoningUtils.hpp"
#include "../utils/UTF8TokenBuffer.hpp"
#include "ContextSlider.hpp"
#include "LlmContext.hpp"
#include "SequenceDriver.hpp"
#include "ToolsCompactController.hpp"
#include "inference-addon-cpp/Logger.hpp"

/// A multimodal session cache is only safe to restore when its header carries
/// the full four-field metadata contract (`SessionMetadataField`). The GGSQ
/// loader restores the sequence KV before this check, so any other count — a
/// truncated/legacy header (`< 4`) or an unexpected layout (`> 4`) — must be
/// rejected and the restored KV cleared, never accepted with defaulted
/// `cacheTokens`/`firstMsgCacheTokens`. See `MtmdLlmContext::loadCache`.
[[nodiscard]] inline bool mtmdSessionMetadataIsComplete(size_t tokenCount) {
  return tokenCount == SESSION_METADATA_FIELD_COUNT;
}

/// Multimodal LLM context. Implements both the legacy `LlmContext` API
/// (driven by the single-prompt path in `LlamaModel`) and the per-sequence
/// `SequenceDriver` API (driven by the `ContinuousBatchScheduler`).
/// Per-slot driver instances share the model's `mtmd_context` (mmproj
/// weights) instead of loading their own; safe because the scheduler's
/// single worker thread serialises all media encodes.
class MtmdLlmContext : public LlmContext, public SequenceDriver {
public:
  /**
   * The constructor.
   *
   * @param params - the parameters.
   * @param _llama_init - The result of initializing/loading the model using
   * .gguf file(s)
   * @param tools - reference to the tools compact controller
   */
  MtmdLlmContext(
      common_params& commonParams, common_init_result_ptr llamaInit,
      ToolsCompactController& tools);

  /// Per-slot driver constructor for the continuous-batching path. Does
  /// not own llama handles or the vision context; `sharedVision` must
  /// outlive this instance.
  MtmdLlmContext(
      const common_params& commonParams, const LlmModelContext& shared,
      ToolsCompactController& tools, mtmd_context* sharedVision,
      llama_seq_id seqId, llama_pos perSeqCtxCeiling = -1);

  /**
   * The destructor.
   */
  ~MtmdLlmContext() override = default;
  MtmdLlmContext(const MtmdLlmContext&) = delete;
  MtmdLlmContext& operator=(const MtmdLlmContext&) = delete;
  MtmdLlmContext(MtmdLlmContext&&) = delete;
  MtmdLlmContext& operator=(MtmdLlmContext&&) = delete;

  /**
   * The eval message method. It evaluates the message.
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
   * The generate response method. It generates the response.
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

  /// SequenceDriver KV-cell usage: M-RoPE media commits more KV cells than
  /// positions, so admission must size the cap from `cacheTokens`, not
  /// `nPast`. Diverges from the base default after a cache load restores
  /// `cacheTokens > nPast`.
  [[nodiscard]] llama_pos getKvCellsUsed() const override;

  /**
   * The set n_past method. It sets the n_past.
   *
   * @param n_past - the n_past.
   */
  void setNPast(llama_pos nPast) override;

  void syncPosition(llama_pos currentPos) override;

  [[nodiscard]] llama_pos getCacheTokens() const override;
  void setCacheTokens(llama_pos cacheTokens) override;

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

  [[nodiscard]] llama_pos getFirstMsgCacheTokens() const override;
  void setFirstMsgCacheTokens(llama_pos firstMsgCacheTokens) override;

  /**
   * The set n_discarded method. It sets the n_discarded.
   *
   * @param nDiscarded - the number of tokens to discard.
   */
  void setNDiscarded(llama_pos nDiscarded) override;

  [[nodiscard]] int32_t getNSlides() const override;
  void resetNSlides() override;

  [[nodiscard]] double getVisionEncodeMs() const override;
  [[nodiscard]] int32_t getVisionEncodeTiles() const override;
  void resetVisionEncodeMs() override;

  [[nodiscard]] int32_t getThinkingBlockDiscards() const override;
  void resetThinkingBlockDiscards() override;

  [[nodiscard]] bool supportsSliding() const override { return false; }

  /**
   * The load media method. It loads the media from memory buffer.
   *
   * @param media - the media memory buffer.
   */
  void loadMedia(const std::vector<uint8_t>& media) override;

  /**
   * The load media method. It loads the media from file.
   *
   * @param fname - the file name.
   */
  void loadMedia(const std::string& fname) override;

  /**
   * The reset state method. It resets the context.
   *
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

  /**
   * The reset media method. It resets the media.
   *
   */
  void resetMedia() override;

  /// Raw vision context in use: the shared one in per-slot driver mode,
  /// else the owned one. Exposed so `LlamaModel` can hand the loaded
  /// mmproj to per-slot batch drivers.
  [[nodiscard]] mtmd_context* visionContext() const override {
    return sharedVision_ != nullptr ? sharedVision_ : ctxVision_.get();
  }

  // SequenceDriver interface (continuous-batching path)

  PrefillPlan preparePrefill(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools,
      const std::vector<std::vector<uint8_t>>& media,
      const std::vector<PlannedMedia>& mediaPlan, bool isCacheLoaded,
      bool isPrefillOnlyRequest) override;

  llama_pos evalMediaSegment(size_t mediaIndex, llama_pos pos) override;

  void
  onPrefillComplete(llama_pos currentPos, size_t prefillTokenCount) override;

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

  /// Disk prompt-cache for a multimodal batch slot, round-tripping the full
  /// four-field session metadata (see MtmdLlmContext.cpp). `loadCache` records
  /// the discard budget and returns false (cache miss) on an empty key, a
  /// missing file, or a header that fails the four-field metadata check.
  [[nodiscard]] bool loadCache(
      const std::string& cacheKey, llama_pos configuredNDiscarded) override;
  void saveCache(const std::string& cacheKey) const override;

private:
  /**
   * The check antiprompt method. It checks the antiprompt.
   *
   * @return - true if the antiprompt is found, false otherwise.
   */
  bool checkAntiprompt();

  /**
   * The tokenize chat method. It tokenizes the chat.
   *
   * @param chatMsgs - chat messages.
   * @param tools - tools.
   * @param chunks - output chunks.
   * @param isCacheLoaded - whether the cache is loaded.
   */
  void tokenizeChat(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, mtmd::input_chunks& chunks,
      bool isCacheLoaded);

  /**
   * The init vision context method. It initializes the vision context.
   *
   */
  void initVisionContext();

  void flushPendingUtf8ToCallback(
      const std::function<void(const std::string&)>& outputCallback);
  void refreshCurrentCacheTokensFromMemory();
  /// Advance the logical position to `newPos`, growing physical KV-cell usage
  /// 1:1. Prompt trailing text and every scheduler-fed generated token consume
  /// one KV cell per position; media cells are added separately by
  /// evalMediaSegment(). Single source of truth tying cacheTokens to pos for
  /// text spans, so every position advance keeps the KV-cell count honest.
  void advanceTextSpan(llama_pos newPos);
  void applyContextDiscard();
  void handleStopRequestAndAddEot(LlamaBatch& batchPtr);
  void initializeCommonState();
  [[nodiscard]] llama_pos ctxCeiling() const;

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
  mtmd::context_ptr ctxVision_;
  /// Non-owning vision context for per-slot batch drivers; null in
  /// single-prompt mode (where `ctxVision_` owns the mmproj).
  mtmd_context* sharedVision_ = nullptr;
  LlmModelContext modelCtx_;
  CommonSamplerPtr smpl_;

  common_params params_;
  common_chat_templates_ptr tmpls_;
  std::vector<llama_token> antipromptTokens_;

  mtmd::bitmaps bitmaps_;
  /// Chunks staged by `preparePrefill` for the batch path; media barriers
  /// index into this container until the scheduler evaluates them.
  mtmd::input_chunks stagedChunks_;
  ContextUsage current_;
  ContextUsage protectedPrefix_;
  llama_pos nDiscarded_ = 0;
  llama_pos perSeqCtxCeiling_ = -1;
  int32_t nSlides_ = 0;
  double visionEncodeMs_ = 0.0;
  int32_t visionEncodeTiles_ = 0;
  bool pendingBatchFirstMsg_ = false;

  // UTF-8 token buffer for handling incomplete emoji sequences
  qvac_lib_inference_addon_llama::UTF8TokenBuffer utf8Buffer_;

  // GPT-OSS Harmony: <|call|> is a frame delimiter, not a stop signal
  bool isHarmonyModel_ = false;
  llama_token harmonyCallToken_ = LLAMA_TOKEN_NULL;

  // Force-opens the reasoning channel in the prompt suffix. The text mirrors
  // the template-specific visible reasoning opener so consumers see balanced
  // tags.
  bool thinkingForcedOpen_ = false;
  std::string thinkingForcedOpenText_;

  // Reasoning channel detection state (Qwen3 / Gemma 4 / ...). Empty
  // tags when the active model has no recognised channel.
  qvac_lib_inference_addon_llama::utils::ReasoningState reasoningState_;
  bool reasoningEnabled_ = false;

  // True only for architectures in the Qwen3 reasoning family. Gates
  // the EOS-inside-reasoning recovery (close-marker substitution),
  // which is the historical Qwen3-specific workaround. Detection /
  // span tracking / KV compaction stay family-agnostic via
  // `reasoningEnabled_`. In practice no multimodal model is in the
  // Qwen3 family today, so this gate keeps the recovery dormant on
  // the multimodal path until a Qwen3-family vision model ships.
  bool isQwen3ReasoningFamily_ = false;

  // True when the model uses recurrent memory (Mamba-style SSM layers
  // or hybrid SSM + attention). Detected at construction. Opting in to
  // `remove_thinking_from_context` on such models throws from
  // `applyGenerationParams` to avoid SSM hidden-state contamination.
  bool hasRecurrentMemory_ = false;

  // Per-request toggle for the post-generation thinking-block KV
  // cache compaction. Default-off (opt-in via `generationParams`); set
  // by `applyGenerationParams`.
  bool removeThinkingFromContext_ = false;

  // [start, end) KV positions of the reasoning block emitted in this
  // inference. `end == -1` marks an open (still-being-emitted) span.
  std::optional<std::pair<llama_pos, llama_pos>> thinkSpan_;
  bool pendingThinkCloseCapture_ = false;

  int32_t thinkingBlockDiscards_ = 0;

  std::atomic<bool> stopGeneration_ = false;
};

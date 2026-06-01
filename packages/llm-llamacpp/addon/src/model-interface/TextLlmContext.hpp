#pragma once

#include <atomic>

#include <llama-cpp.h>
#include <llama.h>

#include "../utils/ChatTemplateUtils.hpp"
#include "../utils/Qwen3ReasoningUtils.hpp"
#include "../utils/UTF8TokenBuffer.hpp"
#include "LlmContext.hpp"
#include "ToolsCompactController.hpp"
#include "common/common.h"
#include "common/speculative.h"
#include "inference-addon-cpp/Logger.hpp"

class TextLlmContext : public LlmContext {
public:
  TextLlmContext(const TextLlmContext&) = delete;
  TextLlmContext& operator=(const TextLlmContext&) = delete;
  TextLlmContext(TextLlmContext&&) = delete;
  TextLlmContext& operator=(TextLlmContext&&) = delete;
  // Constructor
  TextLlmContext(
      common_params& commonParams, common_init_result_ptr llamaInit,
      ToolsCompactController& tools);

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
  llama_model* getModel() override { return model_; }

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

  [[nodiscard]] int32_t getNSlides() const override;
  void resetNSlides() override;

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

  [[nodiscard]] common_chat_format getLastChatFormat() const override {
    return lastChatFormat_;
  }

  [[nodiscard]] const std::string& getLastChatParser() const override {
    return lastChatParser_;
  }

  [[nodiscard]] const std::string& getLastGenerationPrompt() const override {
    return lastGenerationPrompt_;
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

  bool handleQwen3ReasoningEOS(
      llama_token& tokenId, std::string& tokenStr, llama_batch& batch,
      llama_pos& nPast,
      const std::function<void(const std::string&)>& outputCallback);

  void flushPendingUtf8ToCallback(
      const std::function<void(const std::string&)>& outputCallback);
  void applyContextDiscard();
  void handleStopRequestAndAddEot(LlamaBatch& batch);

  // Wraps llama_decode(lctx_, batch). When MTP/speculative is active, also
  // feeds the batch into common_speculative_process so the draft context's
  // KV cache tracks the target's on every prefill ubatch + generation step.
  int decodeAndSpecProcess(const llama_batch& batch);

  ToolsCompactController& tools_;
  common_init_result_ptr llamaInit_;
  llama_model* model_;
  llama_context* lctx_;
  const llama_vocab* vocab_;
  CommonSamplerPtr smpl_;

  common_params params_;
  common_chat_templates_ptr tmpls_;
  std::vector<llama_token> antipromptTokens_;

  llama_pos nPast_ = 0;
  llama_pos nDiscarded_ = 0;
  llama_pos firstMsgTokens_ = 0;
  int32_t nSlides_ = 0;
  ThreadPoolPtr threadpool_;
  ThreadPoolPtr threadpoolBatch_;

  // UTF-8 token buffer for handling incomplete emoji sequences
  qvac_lib_inference_addon_llama::UTF8TokenBuffer utf8Buffer_;

  // Reasoning state for Qwen3 models
  qvac_lib_inference_addon_llama::utils::Qwen3ReasoningState reasoningState_;

  // Cache whether this is a Qwen3 model (checked once at load time)
  bool isQwen3Model_ = false;

  // GPT-OSS Harmony: <|call|> is a frame delimiter, not a stop signal
  bool isHarmonyModel_ = false;
  llama_token harmonyCallToken_ = LLAMA_TOKEN_NULL;

  // Force-opens the reasoning channel in the prompt suffix to prepend the
  // matching "<think>\n" opener to the visible stream so consumers see balanced
  // tags.
  bool thinkingForcedOpen_ = false;

  common_chat_format lastChatFormat_ = COMMON_CHAT_FORMAT_CONTENT_ONLY;

  // Serialized PEG parser and generation prompt from the most recent prompt
  // template application, needed by post-generation tool-call extraction (see
  // getLastChatParser / getLastGenerationPrompt).
  std::string lastChatParser_;
  std::string lastGenerationPrompt_;

  // Speculative decoding state for MTP. If non-null, the draft context and spec struct are live
  // and common_speculative_process is called on every decode.
  llama_context_ptr      ctxDraft_;
  common_speculative_ptr spec_;
  // common_speculative_begin must run once before the first decode of each
  // generation; this flag de-duplicates across multi-turn calls.
  bool specBeganGenerate_ = false;
  // common_speculative_get_draft_params requires a non-null .prompt; the MTP
  // impl never reads its contents (only id_last/n_past/n_max), but the wrapper
  // dereferences ->size() for logging.
  std::vector<llama_token> specDummyPrompt_;
  // Sampled-but-not-yet-consumed token from the previous iteration's
  // sample_and_accept_n (the "extra" id past the last accepted draft).
  // LLAMA_TOKEN_NULL means: sample fresh next iter.
  llama_token pendingSampled_ = LLAMA_TOKEN_NULL;
  // Snapshot of ctxDraft_'s partial sequence state (SWA + recurrent) taken
  // right before common_speculative_draft AR-decodes onto ctx_dft.
  std::vector<uint8_t> specCkptDft_;

  std::atomic<bool> stopGeneration_ = false;
};

#pragma once
// NOLINTBEGIN(readability-identifier-naming)
#include <atomic>

#include <llama.h>

#include "../utils/ChatTemplateUtils.hpp"
#include "../utils/Qwen3ReasoningUtils.hpp"
#include "../utils/UTF8TokenBuffer.hpp"
#include "LlmContext.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

class TextLlmContext: public LlmContext {
public:
  TextLlmContext(const TextLlmContext&) = delete;
  TextLlmContext& operator=(const TextLlmContext&) = delete;
  TextLlmContext(TextLlmContext&&) = delete;
  TextLlmContext& operator=(TextLlmContext&&) = delete;
  // Constructor
  TextLlmContext(common_params& commonParams, common_init_result&& llamaInit);

  // Destructor
  ~TextLlmContext() override = default;

  /**
   * The eval message method. It evaluates the message and updates the context.
   *
   * @param chatMsgs - chat messages.
   * @param is_cache_loaded - whether the cache is loaded.
   * @return - true if successful, false if inference is stopped.
   */
  bool evalMessage(
      const std::vector<common_chat_msg>& chatMsgs,
      bool isCacheLoaded) override;

  /**
   * The eval message with tools method. It evaluates the message with tools and
   * updates the context.
   *
   * @param chatMsgs - chat messages.
   * @param tools - tools.
   * @param isCacheLoaded - whether the cache is loaded.
   * @return - true if successful, false if inference is stopped.
   */
  bool evalMessageWithTools(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, bool isCacheLoaded) override;

  /**
   * The generate response method. It generates the response token by token.
   *
   * @param output_callback - the output callback.
   * @return - true if successful, false if context overflow.
   */
  bool generateResponse(
      const std::function<void(const std::string&)>& outputCallback) override;

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
      llama_token& tokenId, std::string& tokenStr, llama_batch* batchPtr,
      llama_pos& n_past,
      const std::function<void(const std::string&)>& outputCallback);

  common_init_result llama_init; // NOLINT(readability-identifier-naming)
  llama_model* model;            // NOLINT(readability-identifier-naming)
  llama_context* lctx;           // NOLINT(readability-identifier-naming)
  const llama_vocab* vocab;      // NOLINT(readability-identifier-naming)
  CommonSamplerPtr smpl;         // NOLINT(readability-identifier-naming)

  common_params params;            // NOLINT(readability-identifier-naming)
  common_chat_templates_ptr tmpls; // NOLINT(readability-identifier-naming)
  std::vector<llama_token>
      antiprompt_tokens; // NOLINT(readability-identifier-naming)

  llama_pos n_past = 0;           // NOLINT(readability-identifier-naming)
  llama_pos n_discarded = 0;      // NOLINT(readability-identifier-naming)
  llama_pos firstMsgTokens = 0;   // NOLINT(readability-identifier-naming)
  ThreadPoolPtr threadpool;       // NOLINT(readability-identifier-naming)
  ThreadPoolPtr threadpool_batch; // NOLINT(readability-identifier-naming)

  // UTF-8 token buffer for handling incomplete emoji sequences
  qvac_lib_inference_addon_llama::UTF8TokenBuffer utf8_buffer_;

  // Reasoning state for Qwen3 models
  qvac_lib_inference_addon_llama::utils::Qwen3ReasoningState reasoning_state_;

  // Cache whether this is a Qwen3 model (checked once at load time)
  bool is_qwen3_model_ = false;

  std::atomic<bool> stop_generation = false;
};

// NOLINTEND(readability-identifier-naming)

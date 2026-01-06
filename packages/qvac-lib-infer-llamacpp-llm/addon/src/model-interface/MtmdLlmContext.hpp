#pragma once
// NOLINTBEGIN(readability-identifier-naming)
#include <atomic>

#include <llama.h>
#include <llama/mtmd/mtmd.h>

#include "../utils/UTF8TokenBuffer.hpp"
#include "LlmContext.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

class MtmdLlmContext: public LlmContext {
public:
  /**
   * The constructor.
   *
   * @param params - the parameters.
   * @param _llama_init - The result of initializing/loading the model using
   * .gguf file(s)
   */
  MtmdLlmContext(common_params& commonParams, common_init_result&& llamaInit);

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
   * The generate response method. It generates the response.
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

private:
    /**
     * The check antiprompt method. It checks the antiprompt.
     *
     * @return - true if the antiprompt is found, false otherwise.
    */
    bool check_antiprompt();

    /**
     * The tokenize chat method. It tokenizes the chat.
     *
     * @param chatMsgs - chat messages.
     * @param tools - tools.
     * @param chunks - output chunks.
     * @param isCacheLoaded - whether the cache is loaded.
     */
    void TokenizeChat(
        const std::vector<common_chat_msg>& chatMsgs,
        const std::vector<common_chat_tool>& tools, mtmd::input_chunks& chunks,
        bool isCacheLoaded);

    /**
     * The init vision context method. It initializes the vision context.
     *
    */
    void init_vision_context();

    common_init_result llama_init;
    mtmd::context_ptr ctx_vision;
    llama_model       * model;
    llama_context     * lctx;
    const llama_vocab * vocab;
    CommonSamplerPtr    smpl;

    common_params params;
    common_chat_templates_ptr tmpls;
    std::vector<llama_token> antiprompt_tokens;

    mtmd::bitmaps bitmaps;
    llama_pos n_past = 0;
    llama_pos n_discarded = 0;
    llama_pos firstMsgTokens = 0;

    // UTF-8 token buffer for handling incomplete emoji sequences
    qvac_lib_inference_addon_llama::UTF8TokenBuffer utf8_buffer_;
    std::atomic<bool> stop_generation = false;
};

// NOLINTEND(readability-identifier-naming)

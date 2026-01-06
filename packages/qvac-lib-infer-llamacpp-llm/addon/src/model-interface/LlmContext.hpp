#pragma once
// NOLINTBEGIN(readability-identifier-naming)
#include "addon/LlmErrors.hpp"
#include "common/chat.h"
#include "common/sampling.h"
#include "llama.h"

using namespace qvac_lib_inference_addon_llama::errors;

struct CommonSamplerDeleter {
  void operator()(common_sampler* ptr) {
    if (ptr != nullptr) {
      common_sampler_free(ptr);
    }
  }
};
using CommonSamplerPtr = std::unique_ptr<common_sampler, CommonSamplerDeleter>;

struct BatchDeleter {
  void operator()(llama_batch* ptr) {
    if (ptr != nullptr) { // NOLINTNEXTLINE(clang-analyzer-core.CallAndMessage)
      llama_batch_free(*ptr);
      delete ptr;
    }
  }
};
using BatchPtr = std::unique_ptr<llama_batch, BatchDeleter>;

struct ThreadPoolDeleter{
    void operator()(ggml_threadpool* ptr) {
      if (ptr != nullptr) {
        auto* cpu_dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
        if (cpu_dev == nullptr) {
          throw qvac_errors::StatusError(
              AddonID, toString(NoBackendFound), "no CPU backend found");
        }
        auto* reg = ggml_backend_dev_backend_reg(cpu_dev);
        void* proc_addr =
            ggml_backend_reg_get_proc_address(reg, "ggml_threadpool_free");
        if (proc_addr == nullptr) {
          throw qvac_errors::StatusError(
              AddonID,
              toString(UnableToDeleteThreadPool),
              "Failed to get ggml_threadpool_free function address");
        }
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        auto* ggml_threadpool_free_fn =
            reinterpret_cast<decltype(ggml_threadpool_free)*>(proc_addr);
        ggml_threadpool_free_fn(ptr);
      }
    }
};
using ThreadPoolPtr = std::unique_ptr<ggml_threadpool, ThreadPoolDeleter>;

class LlmContext { // NOLINT(cppcoreguidelines-special-member-functions)
public:
  LlmContext() = default;
  LlmContext(const LlmContext&) = delete;
  LlmContext& operator=(const LlmContext&) = delete;
  LlmContext(LlmContext&&) = delete;
  LlmContext& operator=(LlmContext&&) = delete;
  /**
   * The destructor. It destroys the context.
   *
   */
  virtual ~LlmContext() = default;

  /**
   * The eval message method. It evaluates the message and updates the context.
   *
   * @param chatMsgs - chat messages.
   * @param is_cache_loaded - whether the cache is loaded.
   * @return - true if successful, false if inference is stopped.
   */
  virtual bool evalMessage(
      const std::vector<common_chat_msg>& chatMsgs, bool is_cache_loaded) = 0;

  /**
   * The eval message with tools method. It evaluates the message with tools and
   * updates the context.
   *
   * @param chatMsgs - chat messages.
   * @param tools - tools.
   * @param is_cache_loaded - whether the cache is loaded.
   * @return - true if successful, false if inference is stopped.
   */
  virtual bool evalMessageWithTools(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, bool is_cache_loaded) = 0;

  /**
   * The generate response method. It generates the response token by token.
   *
   * @param output_callback - the output callback.
   * @return - true if successful, false if context overflow.
   */
  virtual bool generateResponse(
      const std::function<void(const std::string&)>& output_callback) = 0;

  /**
   * The stop method. It stops the model inference.
   */
  virtual void stop() = 0;

  /**
   * The get context method. It returns the context.
   *
   * @return - the context.
   */
  virtual llama_context* getCtx() = 0;

  /**
   * The get n_past method. It returns the n_past.
   *
   * @return - the n_past.
   */
  [[nodiscard]] virtual llama_pos getNPast() const = 0;

  /**
   * The set n_past method. It sets the n_past.
   *
   * @param n_past - the n_past.
   */
  virtual void setNPast(llama_pos n_past) = 0;

  /**
   * Get the number of tokens belonging to the first user message.
   */
  [[nodiscard]] virtual llama_pos getFirstMsgTokens() const = 0;

  /**
   * Set the number of tokens belonging to the first user message.
   */
  virtual void setFirstMsgTokens(llama_pos first_msg_tokens) = 0;

  /**
   * Set the number of tokens to discard when overflowing context.
   */
  virtual void setNDiscarded(llama_pos n_discarded) = 0;

  /**
   * The load media method. It loads the media from memory buffer.
   * Default implementation does nothing (for text-only contexts).
   * Override in multimodal contexts to provide media loading functionality.
   *
   * @param media - the media memory buffer.
   * @throws std::runtime_error if media loading fails in multimodal contexts
   */
  virtual void loadMedia(const std::vector<uint8_t>& media) {};

  /**
   * The load media method. It loads the media from file.
   * Default implementation does nothing (for text-only contexts).
   * Override in multimodal contexts to provide media loading functionality.
   *
   * @param fname - the file name.
   * @throws std::runtime_error if media loading fails in multimodal contexts
   */
  virtual void loadMedia(const std::string& fname) {};

  /**
   * The reset state method. It resets the context.
   *
   */
  virtual void resetState(bool resetStats) = 0;

  /**
   * Remove the last N tokens from the model context.
   * This decrements n_past and removes the tokens from the KV cache.
   *
   * @param count - the number of tokens to remove
   * @return the actual number of tokens removed (may be less than requested if
   * not enough tokens exist)
   */
  virtual llama_pos removeLastNTokens(llama_pos count) = 0;

  /**
   * The reset media method. It resets the media.
   *
   */
  virtual void resetMedia() {};
};

// NOLINTEND(readability-identifier-naming)

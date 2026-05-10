#pragma once

#include <algorithm>
#include <functional>
#include <optional>
#include <string>

#include "addon/LlmErrors.hpp"
#include "common/chat.h"
#include "common/sampling.h"
#include "llama.h"

using namespace qvac_lib_inference_addon_llama::errors;

struct GenerationParams {
  std::optional<int> n_predict;
  std::optional<float> temp;
  std::optional<float> top_p;
  std::optional<int> top_k;
  std::optional<float> frequency_penalty;
  std::optional<float> presence_penalty;
  std::optional<float> repeat_penalty;
  std::optional<uint32_t> seed;
  // GBNF grammar applied per request to constrain sampling. When set, the
  // sampler is re-initialized with this grammar for the duration of the
  // request and the prior grammar is restored afterwards. Mirrors the
  // load-time `--grammar` flag but scoped to a single completion call.
  std::optional<std::string> grammar;
  // JSON-Schema applied per request. Converted to GBNF via llama.cpp's
  // `json_schema_to_grammar()` and applied identically to `grammar`.
  // Mutually exclusive with `grammar` — the JS wrapper rejects requests
  // that set both. Mirrors the load-time `--json-schema` flag.
  std::optional<std::string> json_schema;

  [[nodiscard]] bool hasOverrides() const {
    return n_predict || temp || top_p || top_k || frequency_penalty ||
           presence_penalty || repeat_penalty || seed || grammar || json_schema;
  }
};

struct CommonSamplerDeleter {
  void operator()(common_sampler* ptr) {
    if (ptr != nullptr) {
      common_sampler_free(ptr);
    }
  }
};
using CommonSamplerPtr = std::unique_ptr<common_sampler, CommonSamplerDeleter>;

class LlamaBatch {
  llama_batch batch_;
  bool initialized_ = false;

public:
  LlamaBatch() noexcept : batch_{}, initialized_(false) {}

  LlamaBatch(int32_t n_tokens, int32_t embd, int32_t n_seq_max)
      : batch_(llama_batch_init(n_tokens, embd, n_seq_max)),
        initialized_(true) {}

  LlamaBatch(LlamaBatch&& other) noexcept
      : batch_(other.batch_), initialized_(other.initialized_) {
    other.batch_ = llama_batch{};
    other.initialized_ = false;
  }

  LlamaBatch& operator=(LlamaBatch&& other) noexcept {
    if (this != &other) {
      if (initialized_) {
        llama_batch_free(batch_);
      }
      batch_ = other.batch_;
      initialized_ = other.initialized_;
      other.batch_ = llama_batch{};
      other.initialized_ = false;
    }
    return *this;
  }

  LlamaBatch(const LlamaBatch&) = delete;
  LlamaBatch& operator=(const LlamaBatch&) = delete;

  ~LlamaBatch() {
    if (initialized_) {
      llama_batch_free(batch_);
    }
  }

  llama_batch* get() noexcept { return &batch_; }
  const llama_batch* get() const noexcept { return &batch_; }

  llama_batch& operator*() noexcept { return batch_; }
  const llama_batch& operator*() const noexcept { return batch_; }

  llama_batch* operator->() noexcept { return &batch_; }
  const llama_batch* operator->() const noexcept { return &batch_; }
};

struct ThreadPoolDeleter {
  void operator()(ggml_threadpool* ptr) {
    if (ptr != nullptr) {
      auto* cpuDev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
      if (cpuDev == nullptr) {
        throw qvac_errors::StatusError(
            ADDON_ID, toString(NoBackendFound), "no CPU backend found");
      }
      auto* reg = ggml_backend_dev_backend_reg(cpuDev);
      void* procAddr =
          ggml_backend_reg_get_proc_address(reg, "ggml_threadpool_free");
      if (procAddr == nullptr) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            toString(UnableToDeleteThreadPool),
            "Failed to get ggml_threadpool_free function address");
      }
      // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
      auto* ggmlThreadpoolFreeFn =
          reinterpret_cast<decltype(ggml_threadpool_free)*>(procAddr);
      ggmlThreadpoolFreeFn(ptr);
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
   * @param isCacheLoaded - whether the cache is loaded.
   * @param prefill - whether to only prefill context without generation setup.
   * @return - true if successful, false if inference is stopped.
   */
  virtual bool evalMessage(
      const std::vector<common_chat_msg>& chatMsgs, bool isCacheLoaded,
      bool prefill) = 0;

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
  virtual bool evalMessageWithTools(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
      bool prefill) = 0;

  /**
   * The generate response method. It generates the response token by token.
   *
   * @param outputCallback - the output callback.
   * @return - true if successful, false if context overflow.
   */
  virtual bool generateResponse(
      const std::function<void(const std::string&)>& outputCallback) = 0;

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
   * The get model method. It returns the underlying llama_model pointer.
   */
  virtual llama_model* getModel() = 0;

  /**
   * The get params method. It returns a reference to the common parameters
   * associated with this context.
   */
  virtual common_params& getParams() = 0;

  /**
   * The get nPast method. It returns the nPast.
   *
   * @return - the nPast.
   */
  [[nodiscard]] virtual llama_pos getNPast() const = 0;

  /**
   * The set nPast method. It sets the nPast.
   *
   * @param nPast - the nPast.
   */
  virtual void setNPast(llama_pos nPast) = 0;

  /**
   * Get the number of tokens belonging to the first user message.
   */
  [[nodiscard]] virtual llama_pos getFirstMsgTokens() const = 0;

  /**
   * Set the number of tokens belonging to the first user message.
   */
  virtual void setFirstMsgTokens(llama_pos firstMsgTokens) = 0;

  /**
   * Set the number of tokens to discard when overflowing context.
   */
  virtual void setNDiscarded(llama_pos nDiscarded) = 0;

  /**
   * Get the number of context slides (discards) that have occurred.
   */
  [[nodiscard]] virtual int32_t getNSlides() const = 0;

  /**
   * Reset the slide counter to zero. Called at the start of each inference.
   */
  virtual void resetNSlides() = 0;

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
   * Apply per-inference generation parameter overrides and return a callable
   * that restores the original (load-time) values when invoked.
   * Default implementation is a no-op (e.g. for multimodal contexts).
   *
   * @param params - the generation parameter overrides to apply.
   * @return a callable that restores original parameters; safe to call
   *         multiple times (subsequent calls are no-ops).
   */
  virtual std::function<void()>
  applyGenerationParams(const GenerationParams& params) {
    return []() {};
  }

  /**
   * The reset state method. It resets the context.
   *
   */
  virtual void resetState(bool resetStats) = 0;

  /**
   * Remove the last N tokens from the model context.
   * This decrements nPast and removes the tokens from the KV cache.
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

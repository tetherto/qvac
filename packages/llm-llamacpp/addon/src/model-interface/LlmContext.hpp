#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include "SequenceDriver.hpp"
#include "addon/LlmErrors.hpp"
#include "common/chat.h"
#include "common/sampling.h"
#include "llama.h"

using namespace qvac_lib_inference_addon_llama::errors;

struct mtmd_context;

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
  // Reasoning channel budget override. `-1` keeps reasoning unrestricted, `0`
  // disables it, and positive values cap the reasoning channel at that many
  // tokens. Mirrors the load-time `reasoning-budget` config; the override is
  // applied to `params_.reasoning_budget` for the duration of the request and
  // restored on completion.
  std::optional<int> reasoning_budget;
  // Per-request override for post-generation thinking-block KV cache
  // compaction. Contexts default off except the Qwen3 family, which defaults
  // on. `false` keeps the reasoning block in cache; `true` enables
  // compaction. Supported on both pure-attention and recurrent / hybrid-SSM
  // models. Every model rewinds to the reasoning boundary and replays;
  // `TextLlmContext::needsRecurrentSnapshot_` documents what differs between
  // them. Restored at end-of-request.
  std::optional<bool> remove_thinking_from_context;

  // Reports overrides that need `applyGenerationParamsToContext` (sampler /
  // common_params rebuild). Intentionally excludes
  // `remove_thinking_from_context` — that toggle lives on `TextLlmContext`, not
  // on `common_params`, and is applied directly via
  // `setRemoveThinkingFromContext` on both the single- prompt and batch paths.
  // Including it here would force a no-op `common_sampler_init` whenever it's
  // the only override set.
  [[nodiscard]] bool hasOverrides() const {
    return n_predict || temp || top_p || top_k || frequency_penalty ||
           presence_penalty || repeat_penalty || seed || grammar ||
           json_schema || reasoning_budget;
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
  int32_t capacity_ = 0;

public:
  LlamaBatch() noexcept : batch_{}, initialized_(false) {}

  LlamaBatch(int32_t nTokens, int32_t embd, int32_t nSeqMax)
      : batch_(llama_batch_init(nTokens, embd, nSeqMax)), initialized_(true),
        capacity_(nTokens) {}

  LlamaBatch(LlamaBatch&& other) noexcept
      : batch_(other.batch_), initialized_(other.initialized_),
        capacity_(other.capacity_) {
    other.batch_ = llama_batch{};
    other.initialized_ = false;
    other.capacity_ = 0;
  }

  LlamaBatch& operator=(LlamaBatch&& other) noexcept {
    if (this != &other) {
      if (initialized_) {
        llama_batch_free(batch_);
      }
      batch_ = other.batch_;
      initialized_ = other.initialized_;
      capacity_ = other.capacity_;
      other.batch_ = llama_batch{};
      other.initialized_ = false;
      other.capacity_ = 0;
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

  [[nodiscard]] int32_t capacity() const noexcept { return capacity_; }
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

struct LlmModelContext {
  llama_model* model = nullptr;
  llama_context* lctx = nullptr;
  const llama_vocab* vocab = nullptr;
};

/// Canonical layout of the per-session cache metadata that every cache
/// (de)serializer must persist and restore. Any driver implementing
/// `loadCache`/`saveCache` MUST round-trip all four fields in this order.
///
/// `cacheTokens` (physical KV-cell usage) is owned separately from `nPast`
/// (logical positional span) because multimodal M-RoPE media can occupy more
/// KV cells than its positional span. See `getCacheTokens` below.
///
/// Slots 1 and 3 are retired: they carried the first-message counters the
/// removed sliding-context feature protected. The four-field width stays so a
/// file written by either build still loads, and this build's readers ignore
/// them.
///
/// They are not written as 0. A build that still slides reads slot 1 as its
/// protected-prefix boundary and would evict from position 0, silently
/// dropping the system prompt and tool definitions. Mirroring the live cursor
/// instead drives its `leftTokens` negative, so it refuses the slide and
/// reports a context overflow with the cache intact.
///
/// That refusal covers the prefill slide only, the generation slide carried no
/// such guard, so mirroring is the better of the two values we can write, not
/// a guarantee at every slide site.
enum class SessionMetadataField : uint8_t {
  NPast = 0,
  RetiredFirstMsgTokens = 1,
  CacheTokens = 2,
  RetiredFirstMsgCacheTokens = 3,
};

/// Number of `llama_token` fields in the session metadata contract above.
inline constexpr size_t SESSION_METADATA_FIELD_COUNT = 4;

/// The wire form of the contract above. Every `saveCache` / `loadCache` goes
/// through this so the `{nPast, nPast, cacheTokens, cacheTokens}` layout has
/// one home: a writer that left a retired slot at 0 makes an older,
/// still-sliding build evict from position 0 instead of protecting the first
/// message, and that is silent.
struct SessionMetadata {
  std::array<llama_token, SESSION_METADATA_FIELD_COUNT> tokens = {};

  /// Reads the two live fields off a context, then mirrors them into the
  /// retired slots so a downgraded build refuses to slide rather than
  /// evicting from position 0. See the contract above.
  static SessionMetadata capture(const class LlmContext& context);

  /// Writes the two live fields back onto a context.
  void applyTo(class LlmContext& context) const;

  [[nodiscard]] llama_token field(SessionMetadataField which) const {
    return tokens[static_cast<size_t>(which)];
  }
  [[nodiscard]] llama_token nPast() const {
    return field(SessionMetadataField::NPast);
  }
  [[nodiscard]] llama_token cacheTokens() const {
    return field(SessionMetadataField::CacheTokens);
  }

  [[nodiscard]] llama_token* data() { return tokens.data(); }
  [[nodiscard]] const llama_token* data() const { return tokens.data(); }
  [[nodiscard]] size_t size() const { return tokens.size(); }

  /// A partial header leaves `cacheTokens` at zero, which diverges from
  /// `nPast` under M-RoPE and breaks later cap checks.
  [[nodiscard]] static bool isComplete(size_t tokenCount) {
    return tokenCount >= SESSION_METADATA_FIELD_COUNT;
  }
};

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

  struct EvalMessageResult {
    bool ok = true;
    bool cancelled = false;
    bool rollbackOk = true;
  };

  /**
   * The eval message method. It evaluates the message and updates the context.
   *
   * @param chatMsgs - chat messages.
   * @param isCacheLoaded - whether the cache is loaded.
   * @param prefill - whether to only prefill context without generation setup.
   * @return - ok=false when inference is stopped during prefill;
   * cancelled=true when stopped by user cancellation; rollbackOk=false when a
   * cancellation could not restore the pre-request recurrent state and callers
   * must reset live state and invalidate cache persistence for this request.
   */
  virtual EvalMessageResult evalMessage(
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
   * @return - eval result (success / cancellation / rollback status).
   */
  virtual EvalMessageResult evalMessageWithTools(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
      bool prefill) = 0;

  struct GenerateResponseResult {
    bool ok = true;
    bool cancelled = false;
    bool rollbackOk = true;
  };

  /**
   * The generate response method. It generates the response token by token.
   *
   * @param outputCallback - the output callback.
   * @return - cancelled=true when generation was stopped by user cancellation;
   * rollbackOk=false when a cancellation or prediction-limit truncation inside
   * reasoning could not restore the pre-request recurrent state and callers
   * must skip cache persistence for this request. Generation-time context
   * exhaustion is a successful terminal outcome exposed through runtime stats;
   * prompt admission overflow still throws before this method runs.
   */
  virtual GenerateResponseResult generateResponse(
      const std::function<void(const std::string&)>& outputCallback) = 0;

  /**
   * The stop method. It stops the model inference.
   */
  virtual void stop() = 0;

  /**
   * Clears a pending stop request no run consumed. stop() only sets a flag
   * read at fixed points of the eval loop, so a cancel landing after a run's
   * last check (its completion tail) survives it; the next run must start
   * unpoisoned.
   */
  virtual void resetStopFlag() = 0;

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
   * The llama-side sequence id this context owns (0 for the single-prompt
   * path, the scheduler-assigned slot id under continuous batching). Used as
   * the `seq_id` argument when persisting/restoring per-sequence cache state.
   */
  [[nodiscard]] llama_seq_id getSeqId() const { return seqId_; }

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
   * Get the physical KV-cache token usage. This differs from nPast for
   * multimodal M-RoPE prompts where image embeddings can occupy more KV cells
   * than their positional span.
   */
  [[nodiscard]] virtual llama_pos getCacheTokens() const { return getNPast(); }

  /**
   * Set the physical KV-cache token usage.
   */
  virtual void setCacheTokens(llama_pos cacheTokens) { setNPast(cacheTokens); }

  /**
   * Number of `<think>` reasoning blocks compacted out of the KV
   * cache during the most recent generation. 0 for contexts without
   * reasoning channel support.
   */
  [[nodiscard]] virtual int32_t getThinkingBlockDiscards() const { return 0; }
  virtual void resetThinkingBlockDiscards() {}

  /**
   * Why the most recent generation stopped (`None` when no generation
   * has run or the context does not track it). Surfaced to runtime
   * stats as `stopReason` so callers can distinguish a prediction-limit
   * cutoff from a model-signalled EOS.
   */
  [[nodiscard]] virtual GenerationStopReason getGenerationStopReason() const {
    return GenerationStopReason::None;
  }

  /**
   * Consume the per-inference user-visible `llama_perf_context` snapshot
   * if one was captured (by any context that may run a replay decode
   * during thinking-block compaction). Returns
   * `std::nullopt` when no snapshot was taken, in which case the caller
   * should fall back to a live `llama_perf_context()` read.
   *
   * Snapshot rationale: the recurrent / hybrid thinking-block compactor
   * replays the post-reasoning tail through `llama_decode`, which
   * accumulates into `n_p_eval` / `t_p_eval_ms` (and therefore inflates
   * `promptTokens`, `ppTPS`, and `TTFT`). Those tokens were already
   * delivered to the caller, so the replay must not be counted as new
   * user-visible work. Capturing perf just before the replay, and
   * reporting that snapshot from `runtimeStats()`, preserves accurate
   * stats while still letting the replay update the cache state.
   *
   * Idempotent: returning the snapshot also clears the internal slot so
   * subsequent calls (until the next inference) see `nullopt`.
   */
  [[nodiscard]] virtual std::optional<llama_perf_context_data>
  takeUserVisiblePerfSnapshot() {
    return std::nullopt;
  }

  /**
   * Tokens the most recent single-prompt inference actually generated.
   *
   * llama's `n_eval` cannot answer this. It counts decodes whose batch held
   * exactly one token (`llama-context.cpp`: `n_queued_tokens == 1`), so it
   * measures batch shape, not meaning. Generation happens to decode one at a
   * time, which is why the two used to agree, but reasoning compaction now
   * replays the kept tokens as a batch and those land in `n_p_eval` instead.
   * Counting where the tokens are produced keeps the stat honest regardless
   * of how any later cache work is batched.
   */
  [[nodiscard]] virtual int32_t lastGeneratedTokenCount() const {
    return lastGeneratedTokenCount_;
  }

protected:
  int32_t lastGeneratedTokenCount_ = 0;

public:
  /**
   * Wall-clock milliseconds spent in the vision encoder (mtmd/CLIP ViT
   * forward + projection) during the most recent inference. 0 for
   * text-only contexts, which never run a vision encoder.
   */
  [[nodiscard]] virtual double getVisionEncodeMs() const { return 0.0; }

  /**
   * Number of vision-encode slices (image chunks encoded) in the most recent
   * inference — the `tiles` the report shows next to the encode time. 0 for
   * text-only contexts.
   */
  [[nodiscard]] virtual int32_t getVisionEncodeTiles() const { return 0; }

  /**
   * Reset the vision-encode accumulators (ms + slice count) to zero. Called at
   * the start of each inference. No-op for text-only contexts.
   */
  virtual void resetVisionEncodeMs() {}

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

  /// Loaded multimodal (mmproj) context this LLM context can hand to
  /// per-slot batch drivers, or null for text-only contexts. Used by the
  /// scheduler factory to detect media capability without a `dynamic_cast`.
  [[nodiscard]] virtual mtmd_context* visionContext() const { return nullptr; }

protected:
  void clearSequenceMemory(
      llama_context* lctx, llama_pos startPos = -1,
      llama_pos endPos = -1) const {
    if (auto* mem = llama_get_memory(lctx); mem == nullptr) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InternalError),
          "LlmContext: llama memory is null while clearing sequence");
    } else if (!llama_memory_seq_rm(mem, seqId_, startPos, endPos)) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InternalError),
          "LlmContext: failed to clear sequence from KV memory");
    }
  }

  /// llama-side sequence id this context owns. Stamped onto every
  /// token added to a `llama_batch` and used as the `seq_id` argument
  /// to `llama_memory_seq_*` calls. Defaults to 0 so the legacy
  /// single-prompt path (one `LlmContext` per `llama_context`) keeps
  /// its old "always seq 0" behaviour byte-for-byte. Per-slot
  /// instances under `ContinuousBatchScheduler` set this to their
  /// scheduler-assigned slot id at construction.
  llama_seq_id seqId_ = 0;
};

inline SessionMetadata SessionMetadata::capture(const LlmContext& context) {
  SessionMetadata metadata;
  using Field = SessionMetadataField;
  metadata.tokens[static_cast<size_t>(Field::NPast)] =
      static_cast<llama_token>(context.getNPast());
  metadata.tokens[static_cast<size_t>(Field::CacheTokens)] =
      static_cast<llama_token>(context.getCacheTokens());
  // Retired here, read as the protected prefix by any build still sliding.
  // Mirroring the live cursors makes that build's slide guard fail closed.
  metadata.tokens[static_cast<size_t>(Field::RetiredFirstMsgTokens)] =
      metadata.tokens[static_cast<size_t>(Field::NPast)];
  metadata.tokens[static_cast<size_t>(Field::RetiredFirstMsgCacheTokens)] =
      metadata.tokens[static_cast<size_t>(Field::CacheTokens)];
  return metadata;
}

inline void SessionMetadata::applyTo(LlmContext& context) const {
  context.setNPast(nPast());
  context.setCacheTokens(cacheTokens());
}

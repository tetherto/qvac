#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include <llama-cpp.h>

#include "SequenceDriver.hpp"
#include "addon/LlmErrors.hpp"
#include "common/chat.h"
#include "common/sampling.h"
#include "common/speculative.h"
#include "llama.h"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_llama::errors;

struct PromptLayout;
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
  // Per-request override for the post-generation thinking-block KV
  // cache compaction. Default-on at the context level; passing
  // `false` here opts out for this request (keeps the reasoning block
  // in the cache), `true` re-affirms the default. Supported on both
  // pure-attention and recurrent / hybrid-SSM models — recurrent /
  // hybrid takes the snapshot + restore + replay path documented on
  // `TextLlmContext::needsRecurrentSnapshot_`; pure-attention takes
  // the `seq_rm + seq_add` path. Restored at end-of-request.
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
/// `cacheTokens`/`firstMsgCacheTokens` (physical KV-cell usage) are owned
/// separately from `nPast`/`firstMsgTokens` (logical positional span) because
/// multimodal M-RoPE media can occupy more KV cells than its positional span.
/// Persisting only the two positional fields would lose the media KV-cell
/// counts and break context shifting after restore. See `getCacheTokens` /
/// `getFirstMsgCacheTokens` below for the divergence these fields capture.
enum class SessionMetadataField : uint8_t {
  NPast = 0,
  FirstMsgTokens = 1,
  CacheTokens = 2,
  FirstMsgCacheTokens = 3,
};

/// Number of `llama_token` fields in the session metadata contract above.
inline constexpr size_t SESSION_METADATA_FIELD_COUNT = 4;

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
   * @return - ok=false for context overflow; cancelled=true when generation
   * was stopped by user cancellation; rollbackOk=false when a cancellation
   * or prediction-limit truncation inside reasoning could not restore the
   * pre-request recurrent state and callers must skip cache persistence for
   * this request.
   */
  virtual GenerateResponseResult generateResponse(
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
   * Get the number of tokens belonging to the first user message.
   */
  [[nodiscard]] virtual llama_pos getFirstMsgTokens() const = 0;

  /**
   * Set the number of tokens belonging to the first user message.
   */
  virtual void setFirstMsgTokens(llama_pos firstMsgTokens) = 0;

  /**
   * Get physical KV-cache token usage for the protected first message.
   */
  [[nodiscard]] virtual llama_pos getFirstMsgCacheTokens() const {
    return getFirstMsgTokens();
  }

  /**
   * Set physical KV-cache token usage for the protected first message.
   */
  virtual void setFirstMsgCacheTokens(llama_pos firstMsgCacheTokens) {
    setFirstMsgTokens(firstMsgCacheTokens);
  }

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
   * if one was captured (currently only by contexts that may run a
   * recurrent replay decode during thinking-block compaction). Returns
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
   * Speculative-decoding counters for the most recent generation. Zero for
   * contexts that never ran a speculative generation; maintained by the shared
   * `runSpeculativeGeneration` loop and surfaced via RuntimeStats.
   */
  [[nodiscard]] int64_t getDraftAccepted() const { return draftAccepted_; }
  [[nodiscard]] int64_t getDraftTotal() const { return draftTotal_; }

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

  /// Validates an incoming prompt against any policy-level constraints
  /// (size, layout, KV-cache state). Default is a no-op; concrete
  /// contexts (`TextLlmContext`, `MtmdLlmContext`) override as needed.
  /// Used by both the legacy single-prompt path and the per-slot
  /// continuous-batching path before admission.
  virtual void validatePromptPolicy(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, const PromptLayout& layout,
      bool hasKvCacheContext) const {
    (void)chatMsgs;
    (void)tools;
    (void)layout;
    (void)hasKvCacheContext;
  }

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

  // MTP speculative decoding state, shared by TextLlmContext + MtmdLlmContext.
  // The derived contexts populate these during their own initialization.
  llama_context_ptr ctxDraft_;
  common_speculative_ptr spec_;
  // Hard ceiling on the MTP draft length, independent of the unvalidated
  // `spec-draft-n-max` / `n_batch` config. The derived contexts clamp
  // `params.speculative.draft.n_max` to this at init so fabric's own draft loop
  // is bounded, and runSpeculativeGeneration reuses it to bound the
  // `specBatch(nMax + 1)` allocation and the `uint16_t` accepted-count cast.
  static constexpr int MAX_SPEC_DRAFT = 128;
  // common_speculative_get_draft_params requires a non-null .prompt; the MTP
  // impl never reads its contents (only id_last/n_past/n_max).
  std::vector<llama_token> specPromptDummy_;
  // Drafts are capped to the target's bounded partial-seq_rm capacity so a
  // rejected draft is always a plain seq_rm.
  common_context_seq_rm_type ctxTgtSeqRmType_ = COMMON_CONTEXT_SEQ_RM_TYPE_PART;
  int64_t draftAccepted_ = 0;
  int64_t draftTotal_ = 0;
  std::atomic<bool> stopGeneration_ = false;

  // Mirror a target-context KV rollback onto the MTP draft context so the two
  // stay aligned. `startPos` is the first position to drop (matching the
  // target's seq_rm); -1 clears the whole draft sequence. No-op when MTP is
  // inactive (ctxDraft_ null). Best-effort and non-throwing: a failed partial
  // seq_rm on a recurrent draft cache is not immediately fatal.
  //
  // Do NOT assume fabric re-syncs for us. `common_speculative_begin()` is the
  // obvious candidate, but we call it with an empty prompt and the v9840
  // draft_mtp impl returns immediately on `N <= 0` (common/speculative.cpp);
  // even with a prompt it only warns and never resets drafter state
  // (pending_h / i_last / chain_h / verify_h) or clears draft KV. Fabric only
  // issues its own draft-side seq_rm on the `chain_heads` path
  // (n_mtp_layers > 1), which a single-nextn-layer model never takes. This
  // function is therefore the ONLY draft/target alignment mechanism.
  // Skipping it after cancel / resetState / loadCache is exactly what lets
  // the draft and target contexts diverge (orphaned draft KV -> degraded
  // drafts, or MTP silently disabling itself mid-session).
  void rollbackDraftContext(llama_pos startPos = -1) noexcept {
    if (!ctxDraft_) {
      return;
    }
    auto* mem = llama_get_memory(ctxDraft_.get());
    if (mem == nullptr) {
      return;
    }
    if (!llama_memory_seq_rm(mem, seqId_, startPos, -1)) {
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "[LlmContext] MTP draft-context rollback failed; drafts may degrade "
          "until the draft cache re-syncs\n");
    }
  }

  // Wraps llama_decode(target, batch). When MTP is active, also feeds the
  // batch into common_speculative_process so the draft context tracks the
  // target's post-norm hidden states.
  int decodeAndSpecProcess(const llama_batch& batch) {
    // Do NOT force-mark logits for every batch position here.
    //
    // Why this is safe (verified against fabric v9840): the MTP impl puts the
    // TARGET context in *unmasked* nextn mode —
    // `llama_set_embeddings_nextn(ctx_tgt, true, /*masked*/ false)`
    // (common/speculative.cpp) — and the nextn extraction sizes itself as
    // `n_rows = masked ? n_outputs : ubatch.n_tokens`, gated on `n_rows > 0`
    // (src/llama-context.cpp). With masked=false that is `ubatch.n_tokens`, so
    // every position of every ubatch is captured for
    // common_speculative_process() *independently of per-row output marks*.
    // (Do not confuse this with the regular `embd` extraction just above it,
    // which IS gated on `n_outputs > 0` — that buffer is not what MTP reads.)
    //
    // Every caller already marks exactly the rows it needs anyway: prefill
    // marks only the last token, the speculative verify batch marks every row
    // at its call site, and the inline reasoning-recovery decodes mark their
    // single token. Blanket-marking would force the full-vocab lm_head
    // projection plus an N*vocab logits copy over the WHOLE prompt on prefill
    // (a TTFT / OOM hazard on long prompts) for no functional gain.
    const int ret = llama_decode(getCtx(), batch);
    if (ret != 0) {
      return ret;
    }
    if (spec_) {
      if (!common_speculative_process(spec_.get(), batch)) {
        QLOG_IF(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            "[LlmContext] common_speculative_process failed; disabling spec "
            "for the rest of this model lifetime\n");
        spec_.reset();
        ctxDraft_.reset();
      }
    }
    return ret;
  }

  // Positions an inline reasoning-recovery commits directly, outside the
  // headroom-clamped verify batch. Per-context because the two recoveries
  // differ: TextLlmContext::handleReasoningEOS commits the close marker plus 2
  // newlines (3), while MtmdLlmContext::specRecoverReasoning commits only the
  // close marker (1). Reserving a single worst-case 3 for both would make Mtmd
  // refuse a recovery that fits, so each context reports what it actually
  // needs.
  [[nodiscard]] virtual llama_pos specRecoveryPositions() const { return 3; }

  // Make room for an inline reasoning-recovery before it decodes. Recovery
  // decodes `specRecoveryPositions()` tokens directly, while specSetPos() can
  // legitimately leave the cursor at specCtxCeiling() (worst case
  // j == draft.size() == headroom). Without this, an EOS-inside-<think> within
  // a few tokens of the ceiling would throw FailedToDecode — the same failure
  // class the per-round draft clamp removes for the verify batch. Slides first
  // and reports whether recovery can safely proceed.
  //
  // KNOWN LIMIT: the fallback discard bottoms out in
  // ContextShifter::trySlideGeneration, which only slides once nPast + 1
  // exceeds the ceiling. So when the cursor sits 1-2 positions below the
  // ceiling and a context needing 3 (Text) cannot fit, the discard no-ops and
  // generation stops gracefully with ContextOverflow even though a slide budget
  // may exist. Making the slider honour a multi-position request means
  // threading a `needed` count through shared non-speculative slide code, so it
  // is deliberately left out of this MTP change — the current behavior is a
  // safe stop, not a hard failure.
  [[nodiscard]] bool specEnsureRecoveryHeadroom() {
    const llama_pos needed = specRecoveryPositions();
    if (specPos() + needed <= specCtxCeiling()) {
      return true;
    }
    specApplyContextDiscard();
    return specPos() + needed <= specCtxCeiling();
  }

  // MTP speculative-decoding generation loop: draft from the MTP head, verify
  // the draft against the target in one batch, accept the longest matching
  // prefix, and feed each accepted token through specProcessToken.
  GenerateResponseResult runSpeculativeGeneration(
      const std::function<void(const std::string&)>& outputCallback) {
    specBeginGeneration(outputCallback);

    if (stopGeneration_.load()) {
      stopGeneration_.store(false);
      return specCancel(outputCallback);
    }

    common_params& params = getParams();
    // Cap the draft so a fully-rejected draft never exceeds the target's
    // bounded partial-seq_rm capacity.
    int nMax = common_speculative_n_max(&params.speculative);
    if (nMax < 1) {
      nMax = 1;
    }
    // Fixed, code-defined ceiling, independent of config. Both
    // `--spec-draft-n-max` and `--batch-size` reach us via unvalidated config
    // passthrough, so neither can be trusted as a bound: a negative `n_batch`
    // wraps to a huge uint32 that `static_cast<int>` turns back into <= 0,
    // silently no-opping a batchCap-only guard and leaving `nMax`
    // attacker-controlled. Drafts are ~n_mtp_layers, so a small hard cap costs
    // nothing and bounds both the `LlamaBatch(nMax + 1, ...)` allocation below
    // and the `uint16_t` accepted-count cast at accept time. NOTE this only
    // bounds the LOCAL nMax; the derived contexts also clamp
    // params.speculative.draft.n_max to MAX_SPEC_DRAFT at init so fabric's own
    // draft loop (which ignores the per-round dp.n_max hint) is bounded too.
    if (nMax > MAX_SPEC_DRAFT) {
      nMax = MAX_SPEC_DRAFT;
    }
    // Keep the whole verify batch (id_last + nMax drafts = nMax + 1 tokens)
    // within the decode batch: cap at n_batch - 1. `batchCap >= 1` (not > 1)
    // deliberately: `batch-size: 1` is an ordinary config value, not a bogus
    // one, and a `> 1` guard skipped the clamp entirely for it — leaving nMax
    // at MAX_SPEC_DRAFT and building a 129-token verify batch for a context
    // whose n_batch is 1. batchCap == 1 now clamps nMax to 0 (draft-less
    // rounds), which is the correct degenerate behaviour. A wrapped/garbage
    // n_batch still lands <= 0 and is left to MAX_SPEC_DRAFT above.
    if (const int batchCap = static_cast<int>(llama_n_batch(getCtx()));
        batchCap >= 1 && nMax > batchCap - 1) {
      nMax = batchCap - 1;
    }
    if (ctxTgtSeqRmType_ == COMMON_CONTEXT_SEQ_RM_TYPE_RS) {
      // Same boundary reasoning: cap == 0 must clamp, not skip.
      if (const int cap = static_cast<int>(llama_n_rs_seq(getCtx()));
          cap >= 0 && nMax > cap) {
        nMax = cap;
      }
    }
    LlamaBatch specBatch(nMax + 1, 0, 1);

    // Signal a new generation to the drafter. NOTE this does NOT reset drafter
    // state: with an empty prompt the v9840 draft_mtp `begin` returns at once
    // on `N <= 0`, and even with a prompt it only warns. `pending_h` therefore
    // carries over from the previous generation, so the first draft row after
    // a resetState / loadCache / cancel may use a stale predecessor hidden
    // state (harmless — the target verifies every draft token — but it is not
    // the clean slate the call looks like). See rollbackDraftContext().
    common_speculative_begin(spec_.get(), seqId_, {});

    unsigned generated = 0;

    // The prompt is already decoded + speculative-processed, so its logits sit
    // at position -1. Sample the first generated token and treat it as id_last.
    bool sampled = false;
    llama_token idLast = specSampleFirstToken(sampled);
    if (specShouldRecoverReasoning(idLast)) {
      // First generated token is EOS inside <think>: recover inline (close
      // marker decoded via specBatch, then sample the answer), mirroring the
      // in-loop recovery below. The plain specProcessToken(..., nullptr) path
      // used for a normal first token would take processToken's forcedTokens_
      // branch, whose recovery newlines the speculative sampler never consumes
      // — dropping them (Text) or skipping recovery entirely (Mtmd) on this
      // edge.
      clearSequenceMemory(getCtx(), specPos(), -1);
      if (ctxDraft_) {
        clearSequenceMemory(ctxDraft_.get(), specPos(), -1);
      }
      // Same inline-decode headroom requirement as the in-loop recovery below.
      if (!specEnsureRecoveryHeadroom()) {
        return specFinish(outputCallback, /*ok=*/false);
      }
      specRecoverReasoning(idLast, specBatch, outputCallback);
      const llama_token next = specSampleAndAccept(-1);
      const SequenceStepResult step = specProcessToken(
          next, /*sampled=*/true, ++generated, outputCallback, &specBatch);
      idLast = step.token;
      if (step.finished) {
        return specFinish(outputCallback, /*ok=*/true);
      }
    } else {
      // NOTE: the first token is not decoded here — it is decoded as id_last in
      // the first verify batch below. With n_predict == 1 the loop never runs,
      // so that single token is emitted but not committed to the KV cache (a
      // degenerate config for speculative decoding, which targets long
      // generations — the non-spec path decodes it). A caller needing a
      // persisted 1-token cache should not enable spec-type.
      const SequenceStepResult step = specProcessToken(
          idLast, sampled, ++generated, outputCallback, nullptr);
      idLast = step.token;
      if (step.finished) {
        return specFinish(outputCallback, /*ok=*/true);
      }
    }

    std::vector<llama_token> draft;
    while (params.n_predict <= 0 ||
           generated < static_cast<unsigned>(params.n_predict)) {
      if (stopGeneration_.load()) {
        stopGeneration_.store(false);
        return specCancel(outputCallback);
      }

      if (specPos() + 1 > specCtxCeiling()) {
        // Accepted graceful degradation: a successful slide here (and the
        // end-of-generation reasoning-block compaction) shifts the TARGET KV
        // without mirroring onto ctxDraft_, so the draft context lags until it
        // re-syncs via decodeAndSpecProcess. Output stays correct regardless
        // (the target verifies every draft token); only draft acceptance
        // quality dips briefly. Not mirrored on purpose — a position-shift
        // mirror is not a plain seq_rm, and clearing the draft mid-loop is
        // riskier than the benign lag fabric's begin() already handles.
        specApplyContextDiscard();
        if (specPos() + 1 > specCtxCeiling()) {
          return specFinish(outputCallback, /*ok=*/false);
        }
      }

      // Remaining context headroom for THIS round. The verify batch below spans
      // [id_last, draft0 .. draftN-1] up to specPos() + draft.size(); the guard
      // above only proves there is room for id_last (1 slot). To avoid decoding
      // past specCtxCeiling() (which llama_decode rejects -> a hard
      // FailedToDecode at the boundary instead of a graceful stop), the draft
      // length must be <= headroom. headroom >= 0 here (guaranteed by the
      // guard); 0 means "no draft this round, just re-decode id_last".
      const llama_pos headroom = specCtxCeiling() - specPos() - 1;
      const int roundNMax = headroom < static_cast<llama_pos>(nMax)
                                ? static_cast<int>(headroom)
                                : nMax;

      // 1. Draft from the MTP head.
      draft.clear();
      if (spec_) {
        common_speculative_draft_params& dp =
            common_speculative_get_draft_params(spec_.get(), seqId_);
        dp.drafting = true;
        // dp.n_max is a per-round hint. Some fabric drafters honor it, but the
        // MTP drafter (fabric v9840, common/speculative.cpp) bounds the draft
        // only by its own construction-time params.n_max (=
        // min(spec-draft-n-max, n_mtp_layers)) and ignores dp.n_max. Set it for
        // drafters that read it, but do NOT rely on it — the hard headroom
        // guarantee is the explicit truncation below.
        dp.n_max = roundNMax;
        dp.n_past = specPos();
        dp.id_last = idLast;
        dp.prompt = &specPromptDummy_;
        dp.result = &draft;
        common_speculative_draft(spec_.get());
        // Bound the returned draft by BOTH limits regardless of drafter
        // behavior (the MTP drafter ignores the dp.n_max hint):
        //  - `headroom`: keeps the max verify-batch position at
        //    specPos() + headroom = specCtxCeiling() - 1, so the decode can
        //    never run past the context ceiling; and
        //  - `nMax`: the capacity specBatch(nMax + 1) was allocated with.
        //  Fabric
        //    only clamps its params.n_max to n_mtp_layers for chain_heads
        //    archs, so for others draft.size() can exceed nMax (e.g. large
        //    spec-draft-n-max, or nMax lowered by the batchCap/RS clamps) and
        //    overflow common_batch_add — so this bound is required, not just
        //    defensive. Dropped tail tokens are simply not verified this round
        //    (equivalent to a rejected draft; reconciled by the accept below).
        const size_t maxDraft =
            headroom < 0
                ? 0
                : std::min(
                      static_cast<size_t>(nMax), static_cast<size_t>(headroom));
        if (draft.size() > maxDraft) {
          draft.resize(maxDraft);
        }
      }
      if (ctxDraft_) {
        clearSequenceMemory(ctxDraft_.get(), specPos(), -1);
      }

      // 2. Verify: decode [id_last, draft0, ..., draftN-1] in one batch.
      const llama_pos posBase = specPos();
      common_batch_clear(*specBatch);
      common_batch_add(*specBatch, idLast, posBase, {seqId_}, true);
      for (size_t i = 0; i < draft.size(); ++i) {
        common_batch_add(
            *specBatch,
            draft[i],
            posBase + 1 + static_cast<llama_pos>(i),
            {seqId_},
            true);
      }
      if (decodeAndSpecProcess(*specBatch) != 0) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            toString(FailedToDecode),
            "[LlmContext] failed to decode speculative batch\n");
      }

      // 3. Sample + accept the longest matching prefix.
      size_t nAccepted = 0;
      bool finished = false;
      bool reasoningRecovered = false;
      for (size_t j = 0; j <= draft.size(); ++j) {
        if (params.n_predict > 0 &&
            generated >= static_cast<unsigned>(params.n_predict)) {
          break;
        }

        const llama_token tok = specSampleAndAccept(static_cast<int>(j));
        specSetPos(posBase + 1 + static_cast<llama_pos>(j));

        // EOS inside the reasoning channel: drop the rejected tail from both
        // contexts, commit the close marker, then sample the answer fresh.
        if (specShouldRecoverReasoning(tok)) {
          clearSequenceMemory(getCtx(), specPos(), -1);
          if (ctxDraft_) {
            clearSequenceMemory(ctxDraft_.get(), specPos(), -1);
          }
          // Recovery decodes inline (outside the clamped verify batch), so make
          // room for it or stop gracefully instead of hitting FailedToDecode.
          if (!specEnsureRecoveryHeadroom()) {
            return specFinish(outputCallback, /*ok=*/false);
          }
          specRecoverReasoning(tok, specBatch, outputCallback);
          const llama_token next = specSampleAndAccept(-1);
          const SequenceStepResult nstep = specProcessToken(
              next, /*sampled=*/true, ++generated, outputCallback, &specBatch);
          idLast = nstep.token;
          finished = nstep.finished;
          reasoningRecovered = true;
          break;
        }

        const SequenceStepResult step = specProcessToken(
            tok, /*sampled=*/true, ++generated, outputCallback, &specBatch);
        idLast = step.token;
        if (step.finished) {
          finished = true;
          break;
        }
        if (j < draft.size() && tok == draft[j]) {
          ++nAccepted;
          continue;
        }
        break; // mismatch
      }

      if (!reasoningRecovered) {
        // Keep id_last + the accepted drafts, drop the rejected/stop tail from
        // both contexts and reset the cursor to just past the kept prefix.
        const llama_pos keepPos =
            posBase + 1 + static_cast<llama_pos>(nAccepted);
        clearSequenceMemory(getCtx(), keepPos, -1);
        if (ctxDraft_) {
          clearSequenceMemory(ctxDraft_.get(), keepPos, -1);
        }
        specSetPos(keepPos);
        if (!draft.empty() && spec_) {
          common_speculative_accept(
              spec_.get(), seqId_, static_cast<uint16_t>(nAccepted));
        }
      }
      draftAccepted_ += static_cast<int64_t>(nAccepted);
      draftTotal_ += static_cast<int64_t>(draft.size());
      if (finished) {
        break;
      }
    }

    // Unified post-loop cancel, mirroring the non-speculative paths
    // (TextLlmContext::generateResponse / MtmdLlmContext::generateResponse).
    // The loop-top check only sees a stop that arrives before the NEXT round;
    // a stop landing during the final round's body (or once `finished` breaks
    // out / the budget is exhausted) would otherwise be dropped here AND leave
    // `stopGeneration_` set, so the next generation's entry check would cancel
    // a request the caller never cancelled and roll back its fresh prefill.
    if (stopGeneration_.load()) {
      stopGeneration_.store(false);
      return specCancel(outputCallback);
    }

    return specFinish(outputCallback, /*ok=*/true);
  }

  // Context-specific pieces of the MTP loop. The cursor is `nPast_` on
  // TextLlmContext and `current_.pos` on MtmdLlmContext.
  virtual void
  specBeginGeneration(const std::function<void(const std::string&)>&) = 0;
  [[nodiscard]] virtual llama_pos specPos() const = 0;
  virtual void specSetPos(llama_pos pos) = 0;
  [[nodiscard]] virtual llama_pos specCtxCeiling() const = 0;
  virtual void specApplyContextDiscard() = 0;
  virtual llama_token specSampleFirstToken(bool& sampled) = 0;
  virtual llama_token specSampleAndAccept(int logitIdx) = 0;
  virtual SequenceStepResult specProcessToken(
      llama_token tokenId, bool sampled, unsigned generated,
      const std::function<void(const std::string&)>& outputCallback,
      LlamaBatch* inlineDecodeBatch) = 0;
  virtual bool specShouldRecoverReasoning(llama_token tok) = 0;
  virtual void specRecoverReasoning(
      llama_token tok, LlamaBatch& batch,
      const std::function<void(const std::string&)>& outputCallback) = 0;
  virtual GenerateResponseResult specFinish(
      const std::function<void(const std::string&)>& outputCallback,
      bool ok) = 0;
  virtual GenerateResponseResult
  specCancel(const std::function<void(const std::string&)>& outputCallback) = 0;
};

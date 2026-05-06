#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <common/sampling.h>
#include <llama.h>

#include "LlmContext.hpp"
#include "MultiRequestBatcher.hpp"
#include "utils/UTF8TokenBuffer.hpp"

namespace qvac_lib_inference_addon_llama::batching {

/// Per-request streaming sinks. Both are optional; missing callbacks
/// are no-ops.
struct StreamCallbacks {
  std::function<void(uint32_t seqId, const std::string& text)> onToken;
  std::function<void(uint32_t seqId)> onDone;
};

/// One request admitted into the scheduler.
struct SubmitRequest {
  /// Prompt as raw token ids; caller does tokenisation + chat template.
  std::vector<llama_token> tokens;
  /// Per-request sampling/generation overrides on top of the scheduler's
  /// baseline `common_params_sampling` + `n_predict`. When empty the
  /// slot reuses its pre-built base sampler; otherwise the scheduler
  /// builds a per-request override sampler via
  /// `applyGenerationParamsToContext`. The merged `n_predict` is enforced
  /// strictly against the scheduler's per-seq ceiling (`ctxTotalTokens /
  /// batchSize`); requests with `prompt + n_predict` over that ceiling
  /// are rejected at admission rather than silently truncated.
  GenerationParams overrides;
  StreamCallbacks streams;
};

/// Continuous-batching driver: owns the underlying `MultiRequestBatcher`,
/// per-slot `common_sampler` + UTF-8 buffers, and the production wiring
/// to `llama_decode`, `common_sampler_*`, `common_token_to_piece`,
/// `llama_vocab_is_eog` and `llama_memory_seq_rm`.
///
/// Step protocol (caller invokes `step()` in a loop while `hasWork()`):
///   1. fill batch from active slots
///   2. llama_decode
///   3. advance slot positions
///   4. sample for every just-idle slot, fire onToken
///   5. mark EOG / limit-reached slots finished
///   6. extract finished slots, fire onDone, KV-clear
///
/// Single-threaded by contract: callers must not invoke `submit`,
/// `step`, `cancel`, or `clear` concurrently.
class ContinuousBatchScheduler {
public:
  /// @param ctx                Live llama_context. Must outlive `*this`.
  /// @param model              Live llama_model. Must outlive `*this`.
  /// @param maxChunkSize       Tokens fed per slot per step (typically n_batch).
  /// @param ctxTotalTokens     Whole-pool KV-cache size (== llama_n_ctx).
  ///                            Partitioned uniformly across `batchSize`
  ///                            slots; per-seq ceiling is
  ///                            `ctxTotalTokens / batchSize`.
  /// @param batchSize          Concurrent slots (== llama_n_seq_max).
  /// @param batchCapacity      Underlying llama_batch token capacity.
  /// @param renderSpecialTokens Forwarded to common_token_to_piece.
  /// @param baseSampling        Baseline sampling config. One
  ///                            `common_sampler` is pre-built per slot
  ///                            from this; requests without overrides
  ///                            reuse the slot's pre-built sampler
  ///                            (after `common_sampler_reset`) instead
  ///                            of paying for `common_sampler_init`.
  /// @param baseNPredict        Baseline per-request token cap
  ///                            (`common_params::n_predict`). Used when
  ///                            a request supplies no `n_predict`
  ///                            override.
  ContinuousBatchScheduler(
      llama_context* ctx, llama_model* model, unsigned maxChunkSize,
      unsigned ctxTotalTokens, size_t batchSize, int32_t batchCapacity,
      bool renderSpecialTokens,
      const common_params_sampling& baseSampling, int baseNPredict);

  ContinuousBatchScheduler(const ContinuousBatchScheduler&) = delete;
  ContinuousBatchScheduler&
  operator=(const ContinuousBatchScheduler&) = delete;
  ContinuousBatchScheduler(ContinuousBatchScheduler&&) = delete;
  ContinuousBatchScheduler&
  operator=(ContinuousBatchScheduler&&) = delete;

  ~ContinuousBatchScheduler();

  /// Admit one request and return the assigned slot id (`seqId`).
  ///
  /// When `request.overrides.hasOverrides()` is true, builds a
  /// per-request `common_sampler` via `applyGenerationParamsToContext`
  /// (matching the validation surface of the single-prompt path);
  /// otherwise resets and reuses the slot's pre-built base sampler.
  ///
  /// Throws `qvac_errors::StatusError(InvalidArgument)` for any failure:
  /// invalid per-request overrides (malformed `json_schema` or `grammar`
  /// rejected by `common_sampler_init`), no free slot, empty prompt,
  /// prompt exceeding the per-sequence token cap, or
  /// `prompt + n_predict` exceeding the per-sequence cap. Caller is
  /// responsible for tearing down already-admitted slots (e.g. via
  /// `clear()`) when admitting a batch and any one request fails.
  [[nodiscard]] uint32_t submit(SubmitRequest&& request);

  /// Drives one fillBatch + decode + advance + sample iteration.
  /// Returns `true` on a successful decode *or* a no-op (no slot had
  /// tokens to feed). Returns `false` if `llama_decode` reported a
  /// non-zero rc; in that case every still-active slot has already
  /// been finalised with `StopReason::DecodeError`, KV-cleared, and
  /// drained, so the caller's only obligation is to break out of its
  /// driving loop.
  [[nodiscard]] bool step();

  /// True while at least one slot has tokens to feed or sample.
  [[nodiscard]] bool hasWork() const;

  /// Number of currently occupied slots.
  [[nodiscard]] unsigned numActive() const;

  /// Cancel one slot. Frees the per-slot sampler and KV-cache entries
  /// and fires onDone with `Cancelled`.
  bool cancel(uint32_t seqId);

  /// Cancel every active request.
  void clear();

private:
  void emitToken(uint32_t seqId, llama_token tok);
  void flushUtf8(uint32_t seqId);
  void notifyDone(uint32_t seqId);
  void freeSlot(uint32_t seqId);

  struct SlotState {
    StreamCallbacks streams;
    UTF8TokenBuffer utf8;
    /// Per-request override sampler. Null while the slot is using its
    /// pre-built base sampler at `baseSamplers_[seqId]`.
    CommonSamplerPtr overrideSampler;
    /// Per-request generation cap, mirroring `common_params::n_predict`
    /// 1:1 (same type, same convention): max tokens this slot is allowed
    /// to *generate*, excluding prompt. Resolved at admission from
    /// `GenerationParams.n_predict` (falling back to `baseNPredict_`)
    /// after `submit` has *already* validated `prompt + n_predict <=
    /// perSeqMaxTokens_`, so this is the user-requested value as-is —
    /// no scheduler-level clamping. Non-positive (default `-1`, or `0`)
    /// means unlimited at the scheduler level; the underlying
    /// `MultiRequestBatcher`'s ctor-level `maxTokensPerSequence`
    /// ceiling still applies.
    ///
    /// The matching counter is *not* stored here: the batcher already
    /// owns `Request::generatedTokens` (see
    /// `MultiRequestBatcher::requestAt`), so we read its `.size()`
    /// instead of duplicating state on the slot.
    int nPredict = -1;
  };

  /// Pick the active sampler for a slot (override if set, else base).
  [[nodiscard]] common_sampler* activeSampler(uint32_t seqId) const;

  llama_context* ctx_;
  llama_model* model_;
  const llama_vocab* vocab_;
  bool renderSpecialTokens_;

  /// Baseline sampling block + n_predict, used when admitting requests
  /// to derive per-request sampling and cap.
  common_params_sampling baseSampling_;
  int baseNPredict_;

  /// Per-seq hard ceiling = ctxTotalTokens / batchSize. Drives both the
  /// underlying batcher's prompt-size guard and per-request cap clamping.
  unsigned perSeqMaxTokens_;
  MultiRequestBatcher batcher_;
  LlamaBatch batch_;
  /// One pre-built `common_sampler` per slot, built from `baseSampling_`
  /// at construction. Reused (with `common_sampler_reset`) by every
  /// override-free request landing in that slot.
  std::vector<CommonSamplerPtr> baseSamplers_;
  std::vector<std::optional<SlotState>> slots_;
};

} // namespace qvac_lib_inference_addon_llama::batching

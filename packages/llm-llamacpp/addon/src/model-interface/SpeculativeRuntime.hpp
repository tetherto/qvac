#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "common/common.h"
#include "common/fit.h"
#include "common/speculative.h"
#include "llama.h"

namespace qvac_lib_inference_addon_llama::speculative {

/// Load-config keys, spelled like llama-server's flags. The underscore
/// spelling is accepted too, like every other addon-only key.
inline constexpr const char* SPEC_TYPE_KEY = "spec_type";
inline constexpr const char* SPEC_TYPE_KEY_DASHED = "spec-type";
inline constexpr const char* SPEC_DRAFT_N_MAX_KEY = "spec_draft_n_max";
inline constexpr const char* SPEC_DRAFT_N_MAX_KEY_DASHED = "spec-draft-n-max";
inline constexpr const char* SPEC_DRAFT_N_MIN_KEY = "spec_draft_n_min";
inline constexpr const char* SPEC_DRAFT_N_MIN_KEY_DASHED = "spec-draft-n-min";
inline constexpr const char* SPEC_DRAFT_P_MIN_KEY = "spec_draft_p_min";
inline constexpr const char* SPEC_DRAFT_P_MIN_KEY_DASHED = "spec-draft-p-min";
inline constexpr const char* SPEC_DRAFT_MODEL_KEY = "spec_draft_model";
inline constexpr const char* SPEC_DRAFT_MODEL_KEY_DASHED = "spec-draft-model";

/// Upper bound for `spec-draft-n-max`. A verification step decodes the
/// sampled token plus the whole draft, so the draft has to fit one ubatch
/// with room to spare; llama-server does not bound it, but no MTP head or
/// DFlash block produces useful drafts this long.
inline constexpr unsigned MAX_SPEC_DRAFT_N_MAX = 64;

/// Speculative-decoding options from the load config. Absent keys keep
/// llama.cpp's `common_params_speculative` defaults.
struct SpeculativeConfig {
  /// `COMMON_SPECULATIVE_TYPE_NONE` when `spec-type` is absent or "none".
  common_speculative_type type = COMMON_SPECULATIVE_TYPE_NONE;
  std::optional<int32_t> draftNMax;
  std::optional<int32_t> draftNMin;
  std::optional<float> draftPMin;
  /// The draft model file (`spec-draft-model`, llama-server's `-md`). Set
  /// for `draft-dflash` only.
  std::string draftModelPath;

  [[nodiscard]] bool enabled() const {
    return type != COMMON_SPECULATIVE_TYPE_NONE;
  }
};

/// Consumes the speculative keys from the load config. `spec-type` accepts
/// `none`, `draft-mtp`, which drafts with the target model's own
/// next-token heads, and `draft-dflash`, which drafts with the DFlash model
/// given as `spec-draft-model`. Throws std::invalid_argument for an unknown
/// type, a malformed or out-of-range value, both spellings of one key, draft
/// options without a type, `draft-dflash` without an absolute
/// `spec-draft-model` path, or a `spec-draft-model` with another type.
SpeculativeConfig
parseSpeculativeConfig(std::unordered_map<std::string, std::string>& config);

/// Copies `config` into `params.speculative` and sizes the target context's
/// output buffers for a verification batch, exactly as llama-server does
/// before it creates the target context (`server_output_limits`). A DFlash
/// draft model is placed like the target model (its GPU layers and
/// devices), since the addon has no separate options for it. Must run
/// before `common_init_from_params`: `load_mtp` and `n_rs_seq` are derived
/// from `params.speculative` when the model and context are created.
void applySpeculativeConfig(
    const SpeculativeConfig& config, common_params& params);

/// The draft model and context as fabric fits them next to the target model
/// (`common_init_from_params`): an MTP context sharing the target's weights,
/// or a DFlash draft model of its own. Lets a fit projection count the draft
/// side like the load does.
class SpeculativeFitModel {
public:
  /// Null when `params` has no MTP or draft-model speculative decoding.
  static std::unique_ptr<SpeculativeFitModel>
  create(const common_params& params);
  [[nodiscard]] const common_fit_extra_model* extra() const { return &extra_; }

private:
  SpeculativeFitModel() = default;
  common_params params_;
  llama_model_params mparams_{};
  llama_context_params cparams_{};
  common_fit_extra_model extra_{};
};

/// The draft side of one sequence's state: the draft context's memory
/// for the sequence and the speculative implementation's own carry-over
/// (`common_speculative_get_state`). Travels with every in-memory copy of the
/// target sequence state (rollback snapshots, checkpoints, the RAM tier), as
/// llama-server keeps `data_dft` / `data_spec` next to the target state in
/// its prompt cache and checkpoints. Empty when speculative decoding is off.
struct DraftSequenceState {
  std::vector<uint8_t> draft;
  std::vector<uint8_t> spec;
  bool captured = false;

  [[nodiscard]] uint64_t bytes() const noexcept {
    return draft.size() + spec.size();
  }
  void clear() noexcept {
    draft.clear();
    draft.shrink_to_fit();
    spec.clear();
    spec.shrink_to_fit();
    captured = false;
  }
};

/// Captures the draft side of `seqId` for the target context `ctxTgt`.
/// `flags` selects the same scope as the target capture
/// (`LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY` for a partial snapshot). Returns an
/// uncaptured state when `ctxTgt` has no speculative runtime.
[[nodiscard]] DraftSequenceState captureDraftSequenceState(
    llama_context* ctxTgt, llama_seq_id seqId, llama_state_seq_flags flags);

/// Restores the draft side of `seqId` after the target sequence state was
/// restored. An uncaptured `state` resets the draft sequence instead: the
/// target now holds a state the draft context never saw, so drafting starts
/// over from the next decoded batch. With `trimTo >= 0` the draft memory is
/// trimmed to that position afterwards, matching a partial target restore.
void restoreDraftSequenceState(
    llama_context* ctxTgt, llama_seq_id seqId, const DraftSequenceState& state,
    llama_state_seq_flags flags, llama_pos trimTo = -1);

/// Drops the draft side of `seqId`: called whenever the target sequence is
/// replaced by a state that carries no draft side (a `cacheKey` file, which
/// like llama-server's slot files holds the target state only).
void resetDraftSequence(llama_context* ctxTgt, llama_seq_id seqId);

/// Model-wide speculative-decoding state: the draft context (MTP, on the
/// target's weights, or DFlash, on the draft model) created against the
/// target model, and the `common_speculative` that drafts for
/// every sequence of the target context. One per loaded model; sequence
/// drivers hold a non-owning pointer through `LlmModelContext`.
///
/// Must be destroyed before the target context: the draft context points at
/// it (`ctx_other`).
class SpeculativeRuntime {
public:
  /// Creates the draft context and the speculative state. Returns null when
  /// speculative decoding is off, and also, with a warning, when the target
  /// context cannot remove sequence tails at all or the speculative state
  /// fails to initialize: llama-server keeps serving without speculation in
  /// both cases. Throws when the draft model or context cannot be created,
  /// which llama-server treats as a load failure.
  static std::unique_ptr<SpeculativeRuntime>
  create(common_params& params, llama_model* modelTgt, llama_context* ctxTgt);

  SpeculativeRuntime(const SpeculativeRuntime&) = delete;
  SpeculativeRuntime& operator=(const SpeculativeRuntime&) = delete;
  SpeculativeRuntime(SpeculativeRuntime&&) = delete;
  SpeculativeRuntime& operator=(SpeculativeRuntime&&) = delete;
  ~SpeculativeRuntime();

  [[nodiscard]] common_speculative* spec() const { return spec_.get(); }
  [[nodiscard]] llama_context* ctxTgt() const { return ctxTgt_; }
  [[nodiscard]] llama_context* ctxDft() const { return ctxDft_; }
  [[nodiscard]] const common_params_speculative& params() const {
    return params_;
  }
  [[nodiscard]] common_context_seq_rm_type tgtSeqRmType() const {
    return tgtSeqRmType_;
  }
  [[nodiscard]] common_context_seq_rm_type dftSeqRmType() const {
    return dftSeqRmType_;
  }
  /// The largest draft any configured implementation can produce.
  [[nodiscard]] int32_t nDraftMax() const;

  /// Feeds a batch the target context just decoded to the speculative state
  /// (the MTP head and DFlash read the target's hidden states). Call after
  /// every successful target `llama_decode`, as llama-server does after each
  /// decode. Returns false on a draft-context decode failure.
  [[nodiscard]] bool process(const llama_batch& batch) const;

  /// The runtime whose target context is `ctxTgt`, or null.
  [[nodiscard]] static SpeculativeRuntime* forTarget(llama_context* ctxTgt);

  /// Clears the draft memory and the speculative carry-over of `seqId`.
  void resetSequence(llama_seq_id seqId) const;

private:
  SpeculativeRuntime() = default;

  common_params_speculative params_;
  llama_context* ctxTgt_ = nullptr;
  llama_context* ctxDft_ = nullptr;
  common_context_seq_rm_type tgtSeqRmType_ = COMMON_CONTEXT_SEQ_RM_TYPE_NO;
  common_context_seq_rm_type dftSeqRmType_ = COMMON_CONTEXT_SEQ_RM_TYPE_NO;
  // Declaration order matters: `spec_` refers to the draft context owned by
  // `specInit_`, so it is declared after it and destroyed first.
  common_speculative_init_result_ptr specInit_;
  common_speculative_ptr spec_;
};

} // namespace qvac_lib_inference_addon_llama::speculative

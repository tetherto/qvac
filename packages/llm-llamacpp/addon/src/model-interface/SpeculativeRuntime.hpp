#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "common/common.h"
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

/// Upper bound for `spec-draft-n-max`. A verification step decodes the
/// sampled token plus the whole draft, so the draft has to fit one ubatch
/// with room to spare; llama-server does not bound it, but no MTP head
/// produces useful drafts this long.
inline constexpr unsigned MAX_SPEC_DRAFT_N_MAX = 64;

/// Speculative-decoding options from the load config. Absent keys keep
/// llama.cpp's `common_params_speculative` defaults.
struct SpeculativeConfig {
  /// `COMMON_SPECULATIVE_TYPE_NONE` when `spec-type` is absent or "none".
  common_speculative_type type = COMMON_SPECULATIVE_TYPE_NONE;
  std::optional<int32_t> draftNMax;
  std::optional<int32_t> draftNMin;
  std::optional<float> draftPMin;

  [[nodiscard]] bool enabled() const {
    return type != COMMON_SPECULATIVE_TYPE_NONE;
  }
};

/// Consumes the speculative keys from the load config. Only `none` and
/// `draft-mtp` are accepted for `spec-type`: MTP drafts with the target
/// model's own next-token heads and needs no second model file. Throws
/// std::invalid_argument for an unknown type, a malformed or out-of-range
/// value, both spellings of one key, or draft options without a type.
SpeculativeConfig
parseSpeculativeConfig(std::unordered_map<std::string, std::string>& config);

/// Copies `config` into `params.speculative` and sizes the target context's
/// output buffers for a verification batch, exactly as llama-server does
/// before it creates the target context (`server_output_limits`). Must run
/// before `common_init_from_params`: `load_mtp` and `n_rs_seq` are derived
/// from `params.speculative` when the model and context are created.
void applySpeculativeConfig(
    const SpeculativeConfig& config, common_params& params);

/// When automatic fit is on, adds the MTP context and compute buffers to
/// `params.fit_params_target` so the target is fitted with room for them.
/// Port of llama-server's reservation in `load_model`; a failed measurement
/// is logged and ignored, as there.
void reserveSpeculativeFitMemory(common_params& params);

/// Model-wide speculative-decoding state: the MTP draft context created
/// against the target model, and the `common_speculative` that drafts for
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
  /// both cases. Throws when the MTP draft context cannot be created, which
  /// llama-server treats as a load failure.
  static std::unique_ptr<SpeculativeRuntime> create(
      common_params& params, llama_model* modelTgt, llama_context* ctxTgt);

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
  /// (the MTP head mirrors the target's hidden states into the draft
  /// context). Call after every successful target `llama_decode`, as
  /// llama-server does after each decode. Returns false on a draft-context
  /// decode failure.
  [[nodiscard]] bool process(const llama_batch& batch) const;

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

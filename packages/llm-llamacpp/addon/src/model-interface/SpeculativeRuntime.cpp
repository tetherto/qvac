#include "SpeculativeRuntime.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>

#include "CacheLedger.hpp"
#include "addon/LlmErrors.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ParseUnsigned.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

namespace qvac_lib_inference_addon_llama::speculative {

namespace {

using cache::takeConfigKey;

float parseProbability(const std::string& raw, const std::string& option) {
  // strtof rather than std::from_chars: floating-point from_chars is missing
  // from some of the libc++ versions the addon is built with.
  char* end = nullptr;
  const float value = raw.empty() ? NAN : std::strtof(raw.c_str(), &end);
  if (end != raw.c_str() + raw.size() || !std::isfinite(value) ||
      value < 0.0F || value > 1.0F) {
    throw std::invalid_argument(
        option + " must be a number between 0 and 1, got: \"" + raw + "\"");
  }
  return value;
}

bool hasType(
    const common_params_speculative& params, common_speculative_type type) {
  for (const auto candidate : params.types) {
    if (candidate == type) {
      return true;
    }
  }
  return false;
}

// The speculative types the addon creates a draft context for: an MTP head
// on the target's weights, or a separate draft model (DFlash).
bool hasDraftContext(const common_params_speculative& params) {
  return hasType(params, COMMON_SPECULATIVE_TYPE_DRAFT_MTP) || params.has_dft();
}

// Target context -> its speculative runtime, so the sequence-state helpers
// (snapshots, the RAM tier, cache files) reach the draft context without
// threading it through every call. Written at load and unload only.
struct RuntimeRegistry {
  std::mutex mutex;
  std::unordered_map<llama_context*, SpeculativeRuntime*> byTarget;
};

RuntimeRegistry& runtimeRegistry() {
  static RuntimeRegistry registry;
  return registry;
}

// M-RoPE models accept a batch that starts past the last stored position
// (positions may jump forward), others reject any gap.
bool allowsPositionGaps(const llama_model* model) {
  switch (llama_model_rope_type(model)) {
  case LLAMA_ROPE_TYPE_MROPE:
  case LLAMA_ROPE_TYPE_IMROPE:
  case LLAMA_ROPE_TYPE_VISION:
    return true;
  default:
    return false;
  }
}

} // namespace

SpeculativeConfig
parseSpeculativeConfig(std::unordered_map<std::string, std::string>& config) {
  SpeculativeConfig result;
  if (const auto type =
          takeConfigKey(config, SPEC_TYPE_KEY, SPEC_TYPE_KEY_DASHED)) {
    if (type->second == "draft-mtp") {
      result.type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP;
    } else if (type->second == "draft-dflash") {
      result.type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH;
    } else if (type->second != "none") {
      throw std::invalid_argument(
          type->first +
          " must be \"none\", \"draft-mtp\" or \"draft-dflash\", got: \"" +
          type->second + "\"");
    }
  }
  if (const auto draftModel = takeConfigKey(
          config, SPEC_DRAFT_MODEL_KEY, SPEC_DRAFT_MODEL_KEY_DASHED)) {
    if (result.type != COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH) {
      throw std::invalid_argument(
          draftModel->first + " requires spec-type \"draft-dflash\"");
    }
    if (draftModel->second.empty() ||
        !std::filesystem::path(draftModel->second).is_absolute()) {
      throw std::invalid_argument(
          draftModel->first + " must be an absolute path, got: \"" +
          draftModel->second + "\"");
    }
    result.draftModelPath = draftModel->second;
  }
  if (result.type == COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH &&
      result.draftModelPath.empty()) {
    throw std::invalid_argument(
        "spec-type \"draft-dflash\" requires spec-draft-model");
  }
  const common_params_speculative_draft defaults;
  if (const auto nMax = takeConfigKey(
          config, SPEC_DRAFT_N_MAX_KEY, SPEC_DRAFT_N_MAX_KEY_DASHED)) {
    result.draftNMax = static_cast<int32_t>(parseUnsignedInRange(
        nMax->second, 1, MAX_SPEC_DRAFT_N_MAX, nMax->first));
  }
  if (const auto nMin = takeConfigKey(
          config, SPEC_DRAFT_N_MIN_KEY, SPEC_DRAFT_N_MIN_KEY_DASHED)) {
    result.draftNMin = static_cast<int32_t>(parseUnsignedInRange(
        nMin->second, 0, MAX_SPEC_DRAFT_N_MAX, nMin->first));
  }
  if (const auto pMin = takeConfigKey(
          config, SPEC_DRAFT_P_MIN_KEY, SPEC_DRAFT_P_MIN_KEY_DASHED)) {
    result.draftPMin = parseProbability(pMin->second, pMin->first);
  }
  const bool hasDraftOption = result.draftNMax.has_value() ||
                              result.draftNMin.has_value() ||
                              result.draftPMin.has_value();
  if (hasDraftOption && !result.enabled()) {
    throw std::invalid_argument(
        "spec-draft-* options require spec-type \"draft-mtp\" or "
        "\"draft-dflash\"");
  }
  const int32_t nMax = result.draftNMax.value_or(defaults.n_max);
  if (result.draftNMin.value_or(defaults.n_min) > nMax) {
    throw std::invalid_argument(
        "spec-draft-n-min must not exceed spec-draft-n-max (" +
        std::to_string(nMax) + ")");
  }
  return result;
}

void applySpeculativeConfig(
    const SpeculativeConfig& config, common_params& params) {
  if (!config.enabled()) {
    return;
  }
  params.speculative.types = {config.type};
  if (config.draftNMax.has_value()) {
    params.speculative.draft.n_max = *config.draftNMax;
  }
  if (config.draftNMin.has_value()) {
    params.speculative.draft.n_min = *config.draftNMin;
  }
  if (config.draftPMin.has_value()) {
    params.speculative.draft.p_min = *config.draftPMin;
  }
  if (!config.draftModelPath.empty()) {
    // llama-server's -md, with -ngld / -devd following the target model:
    // the addon's device and gpu-layers settings apply to both models.
    params.speculative.draft.mparams.path = config.draftModelPath;
    params.speculative.draft.n_gpu_layers = params.n_gpu_layers;
    params.speculative.draft.devices = params.devices;
  }

  // Every generating sequence feeds its sample plus its whole draft in one
  // step: the batch scheduler grants a sequence at most one ubatch and drops
  // a draft that does not fit, and DFlash drafts every sequence in one batch
  // of n_batch tokens, which fabric asserts on overflow.
  const int32_t perSeqTokens = std::min(
      std::min(params.n_ubatch, params.n_batch),
      params.n_batch / std::max<int32_t>(1, params.n_parallel));
  const int32_t nMaxLimit = perSeqTokens - 1;
  if (nMaxLimit < 1) {
    throw std::invalid_argument(
        "speculative decoding needs room for a sampled and a drafted token per "
        "sequence: raise batch-size / ubatch-size or lower parallel");
  }
  auto& draft = params.speculative.draft;
  if (draft.n_max > nMaxLimit) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[Speculative] spec-draft-n-max %d lowered to %d to fit the batch "
            "(batch-size %d, ubatch-size %d, parallel %d)\n",
            draft.n_max,
            nMaxLimit,
            params.n_batch,
            params.n_ubatch,
            params.n_parallel));
    draft.n_max = nMaxLimit;
    draft.n_min = std::min(draft.n_min, draft.n_max);
  }

  // server_output_limits: a verification step reads one output per drafted
  // token plus the sampled one, for every sequence.
  if (!params.embedding &&
      (params.pooling_type == LLAMA_POOLING_TYPE_UNSPECIFIED ||
       params.pooling_type == LLAMA_POOLING_TYPE_NONE)) {
    auto limits = common_speculative_get_output_limits(
        params.n_batch,
        params.n_parallel,
        common_speculative_n_max(&params.speculative));
    params.n_outputs_max = std::max<int32_t>(1, limits.total);
    params.n_outputs_max_per_seq = std::max<int32_t>(1, limits.per_seq);
  }
}

std::unique_ptr<SpeculativeFitModel>
SpeculativeFitModel::create(const common_params& params) {
  if (!hasDraftContext(params.speculative)) {
    return nullptr;
  }
  // Same construction as fabric's common_init_from_params fit.
  const bool hasDraftModel = params.speculative.has_dft();
  std::unique_ptr<SpeculativeFitModel> model(new SpeculativeFitModel());
  model->params_ = common_base_params_to_speculative(params);
  model->mparams_ = common_model_params_to_llama(model->params_);
  model->cparams_ = common_context_params_to_llama(model->params_);
  if (hasType(params.speculative, COMMON_SPECULATIVE_TYPE_DRAFT_MTP)) {
    model->cparams_.ctx_type = LLAMA_CONTEXT_TYPE_MTP;
  }
  model->cparams_.n_rs_seq = 0;
  model->extra_ = {
      /*.path_model   =*/model->params_.model.path.c_str(),
      /*.mparams      =*/&model->mparams_,
      /*.cparams      =*/&model->cparams_,
      // an MTP context runs on the target's weights, a draft model on its own
      /*.shares_model =*/!hasDraftModel,
  };
  return model;
}

std::unique_ptr<SpeculativeRuntime> SpeculativeRuntime::create(
    common_params& params, llama_model* modelTgt, llama_context* ctxTgt) {
  if (!hasDraftContext(params.speculative)) {
    return nullptr;
  }

  std::unique_ptr<SpeculativeRuntime> runtime(new SpeculativeRuntime());
  runtime->ctxTgt_ = ctxTgt;

  {
    common_params paramsDft = common_base_params_to_speculative(params);
    runtime->specInit_ =
        common_speculative_init_from_params(paramsDft, modelTgt, ctxTgt);
    if (params.speculative.has_dft() &&
        runtime->specInit_->model() == nullptr) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadModel),
          "[Speculative] failed to load the draft model '" +
              paramsDft.model.path + "'\n");
    }
    runtime->ctxDft_ = runtime->specInit_->context();
    if (runtime->ctxDft_ == nullptr) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadModel),
          params.speculative.has_dft()
              ? std::string(
                    "[Speculative] failed to create the draft context\n")
              : std::string(
                    "[Speculative] failed to create the MTP context; the model "
                    "has no MTP layers or they could not be loaded\n"));
    }
    params.speculative.draft.ctx_tgt = ctxTgt;
    params.speculative.draft.ctx_dft = runtime->ctxDft_;
  }

  // Probing clears the context memory, which is empty at load anyway.
  runtime->tgtSeqRmType_ = common_context_can_seq_rm(ctxTgt);
  if (runtime->tgtSeqRmType_ == COMMON_CONTEXT_SEQ_RM_TYPE_NO) {
    QLOG_IF(
        Priority::WARNING,
        "[Speculative] speculative decoding not supported by this context\n");
    return nullptr;
  }
  if (runtime->tgtSeqRmType_ == COMMON_CONTEXT_SEQ_RM_TYPE_FULL) {
    QLOG_IF(
        Priority::DEBUG,
        "[Speculative] speculative decoding will use checkpoints\n");
  }

  try {
    runtime->spec_.reset(common_speculative_init(
        params.speculative, static_cast<uint32_t>(params.n_parallel)));
  } catch (const std::exception& e) {
    QLOG_IF(
        Priority::ERROR,
        string_format(
            "[Speculative] failed to initialize speculative decoding "
            "context: %s\n",
            e.what()));
  }
  if (!runtime->spec_) {
    return nullptr;
  }
  runtime->dftSeqRmType_ = common_context_can_seq_rm(runtime->ctxDft_);
  runtime->params_ = params.speculative;
  {
    auto& registry = runtimeRegistry();
    const std::scoped_lock lock(registry.mutex);
    registry.byTarget[ctxTgt] = runtime.get();
  }

  QLOG_IF(
      Priority::INFO,
      string_format(
          "[Speculative] %s enabled: n_max=%d, n_min=%d, p_min=%.2f\n",
          common_speculative_type_name_str(params.speculative.types).c_str(),
          params.speculative.draft.n_max,
          params.speculative.draft.n_min,
          static_cast<double>(params.speculative.draft.p_min)));
  return runtime;
}

SpeculativeRuntime::~SpeculativeRuntime() {
  auto& registry = runtimeRegistry();
  const std::scoped_lock lock(registry.mutex);
  const auto it = registry.byTarget.find(ctxTgt_);
  if (it != registry.byTarget.end() && it->second == this) {
    registry.byTarget.erase(it);
  }
}

SpeculativeRuntime* SpeculativeRuntime::forTarget(llama_context* ctxTgt) {
  if (ctxTgt == nullptr) {
    return nullptr;
  }
  auto& registry = runtimeRegistry();
  const std::scoped_lock lock(registry.mutex);
  const auto it = registry.byTarget.find(ctxTgt);
  return it != registry.byTarget.end() ? it->second : nullptr;
}

int32_t SpeculativeRuntime::nDraftMax() const {
  return common_speculative_n_max(spec_.get());
}

void SpeculativeRuntime::resetSequence(llama_seq_id seqId) const {
  llama_memory_seq_rm(llama_get_memory(ctxDft_), seqId, -1, -1);
  common_speculative_set_state(spec_.get(), seqId, {});
}

bool SpeculativeRuntime::process(const llama_batch& batch) const {
  // llama-server mirrors every target memory edit onto the draft context
  // (`common_memory`). The addon edits the target sequence in many places
  // (cache reconciliation, rollbacks, checkpoint restores), so instead the
  // draft sequence is brought in line here, right before it receives the
  // batch: a draft tail at or past the batch start is stale and trimmed, and
  // a draft that stops short of it (the target was extended without the
  // draft context) restarts from this batch.
  if (batch.n_tokens > 0 && batch.token != nullptr && batch.embd == nullptr) {
    llama_memory_t memDft = llama_get_memory(ctxDft_);
    const bool gapsAllowed = allowsPositionGaps(llama_get_model(ctxDft_));
    std::unordered_map<llama_seq_id, llama_pos> firstPos;
    for (int32_t k = 0; k < batch.n_tokens; ++k) {
      firstPos.try_emplace(batch.seq_id[k][0], batch.pos[k]);
    }
    for (const auto& [seqId, pos] : firstPos) {
      const llama_pos posMax = llama_memory_seq_pos_max(memDft, seqId);
      if (posMax >= pos) {
        if (!llama_memory_seq_rm(memDft, seqId, pos, -1)) {
          resetSequence(seqId);
        }
      } else if (posMax >= 0 && posMax + 1 < pos && !gapsAllowed) {
        resetSequence(seqId);
      }
    }
  }
  return common_speculative_process(spec_.get(), batch);
}

DraftSequenceState captureDraftSequenceState(
    llama_context* ctxTgt, llama_seq_id seqId, llama_state_seq_flags flags) {
  DraftSequenceState state;
  const SpeculativeRuntime* runtime = SpeculativeRuntime::forTarget(ctxTgt);
  if (runtime == nullptr) {
    return state;
  }
  llama_context* ctxDft = runtime->ctxDft();
  const size_t size = llama_state_seq_get_size_ext(ctxDft, seqId, flags);
  if (size > 0) {
    state.draft.resize(size);
    if (llama_state_seq_get_data_ext(
            ctxDft, state.draft.data(), size, seqId, flags) != size) {
      state.draft.clear();
      return state;
    }
  }
  common_speculative_get_state(runtime->spec(), seqId, state.spec);
  state.captured = true;
  return state;
}

void restoreDraftSequenceState(
    llama_context* ctxTgt, llama_seq_id seqId, const DraftSequenceState& state,
    llama_state_seq_flags flags, llama_pos trimTo) {
  const SpeculativeRuntime* runtime = SpeculativeRuntime::forTarget(ctxTgt);
  if (runtime == nullptr) {
    return;
  }
  if (!state.captured) {
    runtime->resetSequence(seqId);
    return;
  }
  llama_context* ctxDft = runtime->ctxDft();
  if (state.draft.empty()) {
    if ((flags & LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY) == 0) {
      llama_memory_seq_rm(llama_get_memory(ctxDft), seqId, -1, -1);
    }
  } else if (
      llama_state_seq_set_data_ext(
          ctxDft, state.draft.data(), state.draft.size(), seqId, flags) == 0) {
    runtime->resetSequence(seqId);
    return;
  }
  if (trimTo >= 0 &&
      !llama_memory_seq_rm(llama_get_memory(ctxDft), seqId, trimTo, -1)) {
    runtime->resetSequence(seqId);
    return;
  }
  common_speculative_set_state(runtime->spec(), seqId, state.spec);
}

void resetDraftSequence(llama_context* ctxTgt, llama_seq_id seqId) {
  if (const SpeculativeRuntime* runtime =
          SpeculativeRuntime::forTarget(ctxTgt)) {
    runtime->resetSequence(seqId);
  }
}

} // namespace qvac_lib_inference_addon_llama::speculative

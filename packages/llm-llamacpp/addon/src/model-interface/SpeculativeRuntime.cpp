#include "SpeculativeRuntime.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

#include <gguf.h>
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

// The types `spec-draft-model` and the `spec-draft-*` options apply to.
constexpr const char* SPEC_TYPES_WITH_DRAFT =
    "\"draft-mtp\", \"draft-dflash\", \"draft-dspark\" or \"auto\"";

// A non-negative integer stored as any GGUF unsigned or signed integer type,
// or nullopt when `key` is absent or not an integer.
std::optional<uint64_t>
readGgufUnsigned(const gguf_context* ctx, const char* key) {
  const int64_t id = gguf_find_key(ctx, key);
  if (id < 0) {
    return std::nullopt;
  }
  switch (gguf_get_kv_type(ctx, id)) {
  case GGUF_TYPE_UINT8:
    return gguf_get_val_u8(ctx, id);
  case GGUF_TYPE_UINT16:
    return gguf_get_val_u16(ctx, id);
  case GGUF_TYPE_UINT32:
    return gguf_get_val_u32(ctx, id);
  case GGUF_TYPE_UINT64:
    return gguf_get_val_u64(ctx, id);
  case GGUF_TYPE_INT8:
    return std::max<int64_t>(0, gguf_get_val_i8(ctx, id));
  case GGUF_TYPE_INT16:
    return std::max<int64_t>(0, gguf_get_val_i16(ctx, id));
  case GGUF_TYPE_INT32:
    return std::max<int64_t>(0, gguf_get_val_i32(ctx, id));
  case GGUF_TYPE_INT64:
    return std::max<int64_t>(0, gguf_get_val_i64(ctx, id));
  default:
    return std::nullopt;
  }
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

// A positive u32 at `key`, or 0.
int64_t readGgufU32(const gguf_context* ctx, const std::string& key) {
  const int64_t id = gguf_find_key(ctx, key.c_str());
  if (id < 0 || gguf_get_kv_type(ctx, id) != GGUF_TYPE_UINT32) {
    return 0;
  }
  return gguf_get_val_u32(ctx, id);
}

// The integer array at `key`, of any GGUF integer type, or empty.
std::vector<int64_t>
readGgufIntArray(const gguf_context* ctx, const std::string& key) {
  std::vector<int64_t> values;
  const int64_t id = gguf_find_key(ctx, key.c_str());
  if (id < 0 || gguf_get_kv_type(ctx, id) != GGUF_TYPE_ARRAY) {
    return values;
  }
  const size_t n = gguf_get_arr_n(ctx, id);
  const void* data = gguf_get_arr_data(ctx, id);
  const auto read = [&](auto typed) {
    using T = decltype(typed);
    const T* items = static_cast<const T*>(data);
    values.reserve(n);
    for (size_t i = 0; i < n; ++i) {
      values.push_back(static_cast<int64_t>(items[i]));
    }
  };
  switch (gguf_get_arr_type(ctx, id)) {
  case GGUF_TYPE_INT8:
    read(int8_t{});
    break;
  case GGUF_TYPE_UINT8:
    read(uint8_t{});
    break;
  case GGUF_TYPE_INT16:
    read(int16_t{});
    break;
  case GGUF_TYPE_UINT16:
    read(uint16_t{});
    break;
  case GGUF_TYPE_INT32:
    read(int32_t{});
    break;
  case GGUF_TYPE_UINT32:
    read(uint32_t{});
    break;
  case GGUF_TYPE_INT64:
    read(int64_t{});
    break;
  case GGUF_TYPE_UINT64:
    // A value past INT64_MAX reads as negative, which is no layer either.
    read(uint64_t{});
    break;
  default:
    break;
  }
  return values;
}

// The speculative types the addon creates a draft context for: MTP, on the
// target's layers or an external head, or a DFlash or DSpark model.
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

// Whether `tensor` is in another shard of the split model whose shard
// `splitNo` of `splitCount` is `path`. The shards are named as fabric's
// loader finds them (`llama_get_list_splits`). `complete` turns false when a
// shard cannot be read, so absence is then unknown.
bool tensorInOtherShards(
    const std::string& path, uint64_t splitNo, uint64_t splitCount,
    const char* tensor, bool& complete) {
  // split.count is a u16 in fabric; a larger value is not a model it loads.
  if (splitCount > UINT16_MAX || splitNo >= splitCount) {
    complete = false;
    return false;
  }
  std::vector<char> buf(path.size() + 64, 0);
  const int32_t prefixLen = llama_split_prefix(
      buf.data(),
      buf.size(),
      path.c_str(),
      static_cast<int32_t>(splitNo),
      static_cast<int32_t>(splitCount));
  if (prefixLen <= 0) {
    complete = false;
    return false;
  }
  const std::string prefix(buf.data(), static_cast<size_t>(prefixLen));
  for (uint64_t shard = 0; shard < splitCount; ++shard) {
    if (shard == splitNo) {
      continue;
    }
    const int32_t len = llama_split_path(
        buf.data(),
        buf.size(),
        prefix.c_str(),
        static_cast<int32_t>(shard),
        static_cast<int32_t>(splitCount));
    gguf_init_params init = {};
    init.no_alloc = true;
    gguf_context* ctx = gguf_init_from_file(
        std::string(buf.data(), static_cast<size_t>(std::max(len, 0))).c_str(),
        init);
    if (ctx == nullptr) {
      complete = false;
      continue;
    }
    const bool found = gguf_find_tensor(ctx, tensor) >= 0;
    gguf_free(ctx);
    if (found) {
      return true;
    }
  }
  return false;
}

} // namespace

GgufShape readGgufShape(const std::string& path) {
  GgufShape shape;
  gguf_init_params init = {};
  init.no_alloc = true;
  gguf_context* ctx = gguf_init_from_file(path.c_str(), init);
  if (ctx == nullptr) {
    return shape;
  }
  const int64_t arch = gguf_find_key(ctx, "general.architecture");
  if (arch >= 0 && gguf_get_kv_type(ctx, arch) == GGUF_TYPE_STRING) {
    const std::string prefix = gguf_get_val_str(ctx, arch);
    shape.arch = prefix;
    // As fabric's `n_embd_out()`: a Gemma 4 assistant carries the target's
    // width in `embedding_length_out` and its own in `embedding_length`.
    shape.embd = readGgufU32(ctx, prefix + ".embedding_length");
    shape.width = readGgufU32(ctx, prefix + ".embedding_length_out");
    if (shape.width == 0) {
      shape.width = shape.embd;
    }
    shape.layers = readGgufU32(ctx, prefix + ".block_count");
    shape.mtpLayers = readGgufU32(ctx, prefix + ".nextn_predict_layers");
    shape.targetLayers = readGgufIntArray(ctx, prefix + ".target_layers");
    // As fabric's `llama_model_meta_val_str` check: absent, or "true".
    const int64_t confidence =
        gguf_find_key(ctx, (prefix + ".has_confidence_head").c_str());
    if (confidence >= 0) {
      const auto type = gguf_get_kv_type(ctx, confidence);
      shape.confidenceHead =
          (type == GGUF_TYPE_BOOL && gguf_get_val_bool(ctx, confidence)) ||
          (type == GGUF_TYPE_STRING &&
           std::string(gguf_get_val_str(ctx, confidence)) == "true");
    }
  }
  shape.markovHead = gguf_find_tensor(ctx, "markov_w1.weight") >= 0;
  shape.draftVocabMap = gguf_find_tensor(ctx, "d2t") >= 0;
  const int64_t tokens = gguf_find_key(ctx, "tokenizer.ggml.tokens");
  if (tokens >= 0 && gguf_get_kv_type(ctx, tokens) == GGUF_TYPE_ARRAY) {
    shape.vocab = static_cast<int64_t>(gguf_get_arr_n(ctx, tokens));
  }
  const uint64_t splitCount = readGgufUnsigned(ctx, "split.count").value_or(1);
  const uint64_t splitNo = readGgufUnsigned(ctx, "split.no").value_or(0);
  gguf_free(ctx);
  // Fabric's loader assembles every shard's tensors into one model, so a
  // tensor of a split model may be in any of them.
  if (!shape.markovHead && splitCount > 1) {
    shape.markovHead = tensorInOtherShards(
        path, splitNo, splitCount, "markov_w1.weight", shape.tensorsComplete);
  }
  return shape;
}

SpeculativeConfig
parseSpeculativeConfig(std::unordered_map<std::string, std::string>& config) {
  SpeculativeConfig result;
  if (const auto type =
          takeConfigKey(config, SPEC_TYPE_KEY, SPEC_TYPE_KEY_DASHED)) {
    if (type->second == "draft-mtp") {
      result.type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP;
    } else if (type->second == "draft-dflash") {
      result.type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH;
    } else if (type->second == "draft-dspark") {
      result.type = COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK;
    } else if (type->second == "auto") {
      result.autoDetect = true;
    } else if (type->second != "none") {
      throw std::invalid_argument(
          type->first +
          " must be \"none\", \"draft-mtp\", \"draft-dflash\", "
          "\"draft-dspark\" or \"auto\", got: \"" +
          type->second + "\"");
    }
  }
  if (const auto draftModel = takeConfigKey(
          config, SPEC_DRAFT_MODEL_KEY, SPEC_DRAFT_MODEL_KEY_DASHED)) {
    // A DFlash or DSpark model, or an external MTP head (llama-server's
    // `--spec-type draft-mtp -md`).
    if (!result.enabled()) {
      throw std::invalid_argument(
          draftModel->first + " requires spec-type " + SPEC_TYPES_WITH_DRAFT);
    }
    const std::string& path = draftModel->second;
    const auto isSeparator = [](char c) { return c == '/' || c == '\\'; };
    // A leading double separator is a network share or a Windows device
    // path, which `is_absolute` accepts there.
    if (path.empty() || !std::filesystem::path(path).is_absolute() ||
        (path.size() >= 2 && isSeparator(path[0]) && isSeparator(path[1]))) {
      throw std::invalid_argument(
          draftModel->first + " must be an absolute local path, got: \"" +
          path + "\"");
    }
    result.draftModelPath = path;
  }
  if (result.draftModelPath.empty()) {
    if (result.type == COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH) {
      throw std::invalid_argument(
          "spec-type \"draft-dflash\" requires spec-draft-model");
    }
    if (result.type == COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK) {
      throw std::invalid_argument(
          "spec-type \"draft-dspark\" requires spec-draft-model");
    }
    if (result.autoDetect) {
      throw std::invalid_argument(
          "spec-type \"auto\" requires spec-draft-model, whose header it "
          "reads the type from");
    }
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
        std::string("spec-draft-* options require spec-type ") +
        SPEC_TYPES_WITH_DRAFT);
  }
  const int32_t nMax = result.draftNMax.value_or(defaults.n_max);
  if (result.draftNMin.value_or(defaults.n_min) > nMax) {
    throw std::invalid_argument(
        "spec-draft-n-min must not exceed spec-draft-n-max (" +
        std::to_string(nMax) + ")");
  }
  return result;
}

void requireDraftModelFile(const SpeculativeConfig& config) {
  if (config.draftModelPath.empty()) {
    return;
  }
  std::error_code error;
  if (!std::filesystem::is_regular_file(config.draftModelPath, error)) {
    throw std::invalid_argument(
        "spec-draft-model is not a regular file: \"" + config.draftModelPath +
        "\"");
  }
}

std::string mtpHeadMismatch(
    int64_t headWidth, int64_t targetWidth, int64_t headVocab,
    int64_t targetVocab) {
  std::string reason;
  if (headWidth > 0 && targetWidth > 0 && headWidth != targetWidth) {
    reason = "hidden width " + std::to_string(headWidth) + ", the model's " +
             std::to_string(targetWidth);
  }
  if (headVocab > 0 && targetVocab > 0 && headVocab != targetVocab) {
    reason += reason.empty() ? "" : "; ";
    reason += std::to_string(headVocab) + " tokens, the model's " +
              std::to_string(targetVocab);
  }
  return reason;
}

std::string dsparkDrafterMismatch(const GgufShape& drafter, float pMin) {
  if (drafter.arch.empty()) {
    return "";
  }
  if (drafter.arch != "dflash") {
    return "it is a " + drafter.arch + " model, not a DSpark drafter";
  }
  // Not found in a shard set that could not all be read is not absent.
  if (!drafter.markovHead && drafter.tensorsComplete) {
    return "it has no DSpark Markov head (markov_w1); a DFlash drafter takes "
           "spec-type \"draft-dflash\"";
  }
  if (pMin > 0.0F && !drafter.confidenceHead) {
    return "it has no confidence head, which spec-draft-p-min needs; set "
           "spec-draft-p-min to 0";
  }
  return "";
}

std::string dflashTargetMismatch(
    const GgufShape& drafter, int64_t targetWidth, int64_t targetLayers,
    int64_t targetVocab) {
  if (drafter.arch != "dflash") {
    return "";
  }
  std::string reason;
  const auto add = [&reason](const std::string& part) {
    reason += reason.empty() ? "" : "; ";
    reason += part;
  };
  // Its Markov head and draft logits are sized to its own vocabulary, unless
  // a `d2t` map points a reduced one at the model's tokens.
  if (!drafter.draftVocabMap && drafter.vocab > 0 && targetVocab > 0 &&
      drafter.vocab != targetVocab) {
    add(std::to_string(drafter.vocab) + " tokens, the model's " +
        std::to_string(targetVocab));
  }
  // Its input projection takes each target layer's hidden state at its own
  // width.
  if (drafter.embd > 0 && targetWidth > 0 && drafter.embd != targetWidth) {
    add("hidden width " + std::to_string(drafter.embd) + ", the model's " +
        std::to_string(targetWidth));
  }
  // Fabric reads layer inputs 0 through the layer count, the last being the
  // final hidden state.
  if (targetLayers > 0) {
    for (const int64_t layer : drafter.targetLayers) {
      if (layer < 0 || layer > targetLayers) {
        add("it reads target layer " + std::to_string(layer) +
            ", the model has " + std::to_string(targetLayers) + " layers");
        break;
      }
    }
  }
  return reason;
}

std::string draftTargetMismatch(
    const common_params_speculative& params, int64_t targetWidth,
    int64_t targetLayers, int64_t targetVocab) {
  if (!params.has_dft() ||
      (!hasType(params, COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH) &&
       !hasType(params, COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK))) {
    return "";
  }
  return dflashTargetMismatch(
      readGgufShape(params.draft.mparams.path),
      targetWidth,
      targetLayers,
      targetVocab);
}

std::string draftTargetMismatchForFile(
    const common_params_speculative& params, const std::string& targetPath) {
  if (!params.has_dft() ||
      (!hasType(params, COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH) &&
       !hasType(params, COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK))) {
    return "";
  }
  const GgufShape target = readGgufShape(targetPath);
  // Fabric's layer count leaves the MTP layers out.
  const int64_t layers =
      target.layers > target.mtpLayers ? target.layers - target.mtpLayers : 0;
  return draftTargetMismatch(params, target.embd, layers, target.vocab);
}

std::string draftModelMismatch(const common_params_speculative& params) {
  if (!hasType(params, COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK) ||
      !params.has_dft()) {
    return "";
  }
  return dsparkDrafterMismatch(
      readGgufShape(params.draft.mparams.path), params.draft.p_min);
}

common_speculative_type detectSpeculativeType(const std::string& path) {
  const std::string prefix =
      "spec-type \"auto\" cannot read the type of '" + path + "': ";
  gguf_init_params init = {};
  init.no_alloc = true;
  gguf_context* ctx = gguf_init_from_file(path.c_str(), init);
  if (ctx == nullptr) {
    throw std::invalid_argument(prefix + "it is not a readable GGUF file");
  }
  // Everything fabric's reader takes for granted, checked here so a
  // malformed header is an error rather than a GGML_ASSERT.
  std::string reason;
  const int64_t archId = gguf_find_key(ctx, "general.architecture");
  if (archId < 0 || gguf_get_kv_type(ctx, archId) != GGUF_TYPE_STRING) {
    reason = "general.architecture is missing or not a string";
  } else if (readGgufUnsigned(ctx, "split.count").value_or(1) > 1) {
    reason = "it is one shard of a split model, of which fabric reads only "
             "the first; set spec-type explicitly";
  } else {
    const std::string arch = gguf_get_val_str(ctx, archId);
    if (arch != "dflash") {
      const std::string key = arch + ".block_count";
      const int64_t id = gguf_find_key(ctx, key.c_str());
      if (id < 0 || gguf_get_kv_type(ctx, id) != GGUF_TYPE_UINT32 ||
          gguf_get_val_u32(ctx, id) == 0) {
        reason = key + " is missing, not a u32 or 0";
      }
    }
  }
  gguf_free(ctx);
  if (!reason.empty()) {
    throw std::invalid_argument(prefix + reason);
  }
  const auto types = common_speculative_types_from_gguf(path);
  if (types.empty()) {
    throw std::invalid_argument(
        prefix +
        "it is neither a DFlash or DSpark model nor a model with MTP layers");
  }
  return types.front();
}

void applySpeculativeConfig(
    const SpeculativeConfig& requested, common_params& params) {
  if (!requested.enabled()) {
    return;
  }
  SpeculativeConfig config = requested;
  if (config.autoDetect) {
    config.type = detectSpeculativeType(config.draftModelPath);
    config.autoDetect = false;
    QLOG_IF(
        Priority::INFO,
        string_format(
            "[Speculative] spec-type \"auto\" detected \"%s\" from '%s'\n",
            common_speculative_type_to_str(config.type).c_str(),
            config.draftModelPath.c_str()));
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
  // a draft that does not fit, and DFlash and DSpark draft every sequence in
  // one batch of n_batch tokens, which fabric asserts on overflow.
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

bool SpeculativeFitModel::addMemory(
    const char* pathTarget, const llama_model_params& mparamsTarget,
    const llama_context_params& cparamsTarget,
    const std::vector<ggml_backend_dev_t>& devices,
    common_device_memory_data_vec& breakdown) const {
  if (breakdown.size() != devices.size() + 1) {
    return false;
  }
  std::vector<ggml_backend_dev_t> draftDevices;
  uint32_t nLayer = 0;
  uint32_t nCtxTrain = 0;
  uint32_t nExpert = 0;
  common_device_memory_data_vec measured;
  try {
    measured = common_get_extra_device_memory_data(
        &extra_,
        pathTarget,
        &mparamsTarget,
        &cparamsTarget,
        draftDevices,
        nLayer,
        nCtxTrain,
        nExpert,
        GGML_LOG_LEVEL_INFO);
  } catch (const std::exception&) {
    return false;
  }
  return addDraftMemory(
      devices, breakdown, draftDevices, measured, !extra_.shares_model);
}

bool addDraftMemory(
    const std::vector<ggml_backend_dev_t>& devices,
    common_device_memory_data_vec& breakdown,
    const std::vector<ggml_backend_dev_t>& draftDevices,
    const common_device_memory_data_vec& measured, bool countWeights) {
  if (breakdown.size() != devices.size() + 1 ||
      measured.size() != draftDevices.size() + 1) {
    return false;
  }
  const auto add = [countWeights](
                       common_device_memory_data& into,
                       const common_device_memory_data& from) {
    if (countWeights) {
      into.model += from.model;
    }
    into.context += from.context;
    into.compute += from.compute;
  };
  add(breakdown.back(), measured.back());
  for (size_t draft = 0; draft < draftDevices.size(); ++draft) {
    const auto target =
        std::find(devices.begin(), devices.end(), draftDevices[draft]);
    if (target != devices.end()) {
      add(breakdown[static_cast<size_t>(target - devices.begin())],
          measured[draft]);
    }
  }
  return true;
}

std::unique_ptr<SpeculativeRuntime> SpeculativeRuntime::create(
    common_params& params, llama_model* modelTgt, llama_context* ctxTgt) {
  if (!hasDraftContext(params.speculative)) {
    return nullptr;
  }

  std::unique_ptr<SpeculativeRuntime> runtime(new SpeculativeRuntime());
  runtime->ctxTgt_ = ctxTgt;

  const bool isMtp =
      hasType(params.speculative, COMMON_SPECULATIVE_TYPE_DRAFT_MTP);
  {
    common_params paramsDft = common_base_params_to_speculative(params);
    // Checked from the head's header, before fabric loads it.
    if (isMtp && params.speculative.has_dft()) {
      const GgufShape head = readGgufShape(paramsDft.model.path);
      const std::string mismatch = mtpHeadMismatch(
          head.width,
          llama_model_n_embd_out(modelTgt),
          head.vocab,
          llama_vocab_n_tokens(llama_model_get_vocab(modelTgt)));
      if (!mismatch.empty()) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            toString(UnableToLoadModel),
            "[Speculative] the MTP head '" + paramsDft.model.path +
                "' does not match the model: " + mismatch + "\n");
      }
    }
    if (const std::string mismatch = draftModelMismatch(params.speculative);
        !mismatch.empty()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadModel),
          "[Speculative] '" + paramsDft.model.path +
              "' cannot draft for spec-type \"draft-dspark\": " + mismatch +
              "\n");
    }
    if (hasType(params.speculative, COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH) &&
        params.speculative.has_dft() &&
        readGgufShape(paramsDft.model.path).markovHead) {
      // Fabric runs the Markov head either way, but drafts with DFlash's
      // block layout and without confidence truncation.
      QLOG_IF(
          Priority::WARNING,
          "[Speculative] the draft model has a DSpark Markov head; spec-type "
          "\"draft-dspark\" drafts with it as trained\n");
    }
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
      std::string message = "[Speculative] failed to create the draft context";
      if (isMtp && params.speculative.has_dft()) {
        message = "[Speculative] failed to create the MTP context; '" +
                  paramsDft.model.path +
                  "' has no MTP layers or they could not be loaded";
      } else if (isMtp) {
        message = "[Speculative] failed to create the MTP context; the model "
                  "has no MTP layers or they could not be loaded";
      }
      throw qvac_errors::StatusError(
          ADDON_ID, toString(UnableToLoadModel), message + "\n");
    }
    params.speculative.draft.ctx_tgt = ctxTgt;
    params.speculative.draft.ctx_dft = runtime->ctxDft_;
  }
  // Dropping `runtime` frees the draft context, so `params`, which outlives
  // this call, must not keep pointing at it.
  const auto disable = [&params]() -> std::unique_ptr<SpeculativeRuntime> {
    params.speculative.draft.ctx_tgt = nullptr;
    params.speculative.draft.ctx_dft = nullptr;
    return nullptr;
  };

  // Probing clears the context memory, which is empty at load anyway.
  runtime->tgtSeqRmType_ = common_context_can_seq_rm(ctxTgt);
  if (runtime->tgtSeqRmType_ == COMMON_CONTEXT_SEQ_RM_TYPE_NO) {
    QLOG_IF(
        Priority::WARNING,
        "[Speculative] speculative decoding not supported by this context\n");
    return disable();
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
    return disable();
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

namespace {

// common_speculative_process() takes only a common_batch, while the addon
// decodes llama_batch. Same conversion and defaults as fabric's former
// common_batch_from_llama_batch(): seq 0, positions continue from memory, last
// token is output.
common_batch toCommonBatch(llama_context* ctx, const llama_batch& batch) {
  common_batch res(ctx);

  const bool hasToken = batch.token != nullptr;
  const bool hasEmbd = batch.embd != nullptr;
  const auto nEmbd =
      static_cast<size_t>(llama_model_n_embd_inp(llama_get_model(ctx)));

  llama_memory_t mem = llama_get_memory(ctx);
  std::vector<llama_pos> posNext(llama_n_seq_max(ctx));
  for (size_t s = 0; s < posNext.size(); ++s) {
    posNext[s] =
        llama_memory_seq_pos_max(mem, static_cast<llama_seq_id>(s)) + 1;
  }

  for (int32_t i = 0; i < batch.n_tokens; ++i) {
    const int32_t nSeqIds = batch.n_seq_id != nullptr ? batch.n_seq_id[i] : 1;
    const llama_seq_id seqId = batch.seq_id != nullptr ? batch.seq_id[i][0] : 0;

    std::array<llama_pos, GGML_MROPE_SECTIONS> pos{};
    if (batch.pos == nullptr) {
      pos[0] = posNext[seqId]++;
    } else if (hasToken) {
      pos[0] = batch.pos[i];
    } else {
      // Embedding batch: section-major layout pos[j * n_tokens + i].
      for (int32_t j = 0; j < res.n_pos; ++j) {
        pos[j] = batch.pos[j * batch.n_tokens + i];
      }
    }

    const bool output = batch.logits != nullptr ? batch.logits[i] != 0
                                                : i == batch.n_tokens - 1;
    const llama_embd embd = {
        hasEmbd ? batch.embd + static_cast<size_t>(i) * nEmbd : nullptr,
        1,
        nEmbd};

    int32_t idx = 0;
    if (hasToken) {
      idx = res.add(batch.token[i], pos[0], seqId, output);
      if (hasEmbd) {
        res.set_embd(idx, embd);
      }
    } else {
      idx = res.add_embd(embd, pos.data(), seqId, output);
    }

    for (int32_t s = 1; s < nSeqIds; ++s) {
      res.add_seq(idx, batch.seq_id[i][s]);
    }
  }

  return res;
}

} // namespace

bool SpeculativeRuntime::process(const llama_batch& batch) const {
  // llama-server mirrors every target memory edit onto the draft context
  // (`common_memory`). The addon edits the target sequence in many places
  // (cache reconciliation, rollbacks, checkpoint restores), so instead the
  // draft sequence is brought in line here, right before it receives the
  // batch: a draft tail at or past the batch start is stale and trimmed, and
  // a draft that stops short of a token batch (the target was extended
  // without the draft context) restarts from it. Media batches are only
  // trimmed: drafts skip some of them (MTP, position-pinned images), so a
  // gap before one is expected.
  if (batch.n_tokens > 0 && batch.pos != nullptr && batch.seq_id != nullptr) {
    const bool isTokenBatch = batch.token != nullptr && batch.embd == nullptr;
    llama_memory_t memDft = llama_get_memory(ctxDft_);
    const bool gapsAllowed =
        !isTokenBatch || allowsPositionGaps(llama_get_model(ctxDft_));
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
  return common_speculative_process(spec_.get(), toCommonBatch(ctxTgt_, batch));
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

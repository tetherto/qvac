#include "LayaModel.hpp"

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>
#include <nlohmann/json.hpp>

#include "addon/BertErrors.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;

namespace {

using json = nlohmann::ordered_json;

// Keys a Laya load accepts. Everything that shapes the context (pooling,
// ctx_size, ubatch, attention, parallel) is fixed by the single-pass decision
// setup, and embedding options (embd_normalize) do not apply.
const std::unordered_set<std::string>& allowedConfigKeys() {
  static const std::unordered_set<std::string> keys = {
      "device",
      "gpu_layers",
      "gpu-layers",
      "batch_size",
      "batch-size",
      "verbosity",
      "main-gpu",
      "main_gpu",
      "split-mode",
      "split_mode",
      "tensor-split",
      "tensor_split",
      "flash_attn",
      "flash-attn",
      "openclCacheDir"};
  return keys;
}

} // namespace

const std::unordered_map<std::string, std::string>& LayaModel::checkConfig(
    const std::unordered_map<std::string, std::string>& config) {
  for (const auto& [key, value] : config) {
    if (!allowedConfigKeys().contains(key)) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(InvalidConfiguration),
          string_format(
              "%s: '%s' is not a Laya load option; accepted: device, "
              "gpu_layers, batch_size, verbosity, main-gpu, split-mode, "
              "tensor-split, flash_attn, openclCacheDir",
              __func__,
              key.c_str()));
    }
  }
  return config;
}

LayaModel::LayaModel(
    const std::string& modelGgufPath,
    const std::unordered_map<std::string, std::string>& config,
    const std::string& backendsDir)
    : loader_(
          "LayaModel", loadHooks(), modelGgufPath, checkConfig(config),
          backendsDir) {}

LlamaModelLoader::Hooks LayaModel::loadHooks() {
  return {
      .configureParams =
          [this](
              common_params& params,
              const ModelMetaData& metadata,
              bool ctxSizeConfigured) {
            configureParams(params, metadata, ctxSizeConfigured);
          },
      .onLoaded =
          [this](llama_model* model, llama_context* ctx) {
            onLoaded(model, ctx);
          }};
}

void LayaModel::configureParams(
    common_params& params, const ModelMetaData& metadata,
    bool /*ctxSizeConfigured*/) {
  // Reject another architecture before its weights are loaded; without the
  // key, common_laya_init still checks once the model is loaded.
  if (const std::optional<std::string> arch =
          metadata.tryGetString("general.architecture");
      arch.has_value() && *arch != "laya") {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedModel),
        string_format(
            "%s: expected a laya model, got '%s'", __func__, arch->c_str()));
  }

  // As common_laya_context_params: no KV cache is kept between passes, so the
  // context only has to hold one batch, every sequence must fit in one ubatch
  // for the decision head, and a batch holds at most one sequence per token.
  params.embedding = true;
  params.pooling_type = LLAMA_POOLING_TYPE_RANK;
  params.n_ctx = params.n_batch;
  params.n_ubatch = params.n_batch;
  params.n_parallel = static_cast<int32_t>(std::min<int64_t>(
      static_cast<int64_t>(llama_max_parallel_sequences()), params.n_batch));
  params.kv_unified = true;
  // The generic warmup batch is not a laya sequence; onLoaded warms up with
  // common_laya_warmup instead.
  params.warmup = false;
}

void LayaModel::onLoaded(llama_model* /*model*/, llama_context* ctx) {
  // Not a laya model, or its decision metadata is malformed. JSON errors from
  // the metadata are caught as std::exception: nlohmann's exception types are
  // fabric's, not ours.
  try {
    laya_ = common_laya_init(ctx);
  } catch (const std::exception& e) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedModel),
        string_format("%s: %s", __func__, e.what()));
  }

  // Abort a pass in llama_decode once cancel() is requested.
  llama_set_abort_callback(
      ctx,
      [](void* data) -> bool {
        return static_cast<const LayaModel*>(data)->stopCancelled_.load();
      },
      this);

  try {
    common_laya_warmup(laya_.get());
  } catch (const std::invalid_argument& e) {
    // The warmup sequence does not fit the batch: batch_size is too small.
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format("%s: batch_size is too small: %s", __func__, e.what()));
  } catch (const std::exception& e) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadModel),
        string_format("%s: warmup failed: %s", __func__, e.what()));
  }
}

std::any LayaModel::process(const std::any& input) {
  if (input.type() != typeid(std::string)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "LayaModel::process: the input must be the request JSON string");
  }
  return predict(std::any_cast<const std::string&>(input));
}

LayaDecisionResult LayaModel::predict(const std::string& requestJson) {
  loader_.waitForLoadInitialization();
  stopCancelled_.store(false);

  json request;
  try {
    request = json::parse(requestJson);
  } catch (const json::parse_error& e) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidRequest),
        string_format(
            "%s: the request is not valid JSON: %s", __func__, e.what()));
  }

  common_laya_result result;
  try {
    result = common_laya_predict(laya_.get(), request);
  } catch (const std::invalid_argument& e) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidRequest),
        string_format("%s: %s", __func__, e.what()));
  } catch (const std::runtime_error& e) {
    if (stopCancelled_.load()) {
      throw std::runtime_error("Job cancelled");
    }
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(DecodeFailed),
        string_format("%s: %s", __func__, e.what()));
  }

  lastTokens_ = result.n_tokens;
  lastPasses_ = result.n_passes;
  lastSequences_ = result.sequences.size();
  lastMs_ = result.t_ms;

  return LayaDecisionResult{
      result.response.dump(-1, ' ', false, json::error_handler_t::replace)};
}

qvac_lib_inference_addon_cpp::RuntimeStats LayaModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  if (!isLoaded()) {
    return stats;
  }
  stats.emplace_back("total_tokens", static_cast<long long>(lastTokens_));
  stats.emplace_back("total_time_ms", lastMs_);
  stats.emplace_back("sequences", static_cast<long long>(lastSequences_));
  stats.emplace_back("forward_passes", static_cast<long long>(lastPasses_));
  stats.emplace_back(
      "batch_size", static_cast<long long>(loader_.params().n_batch));
  stats.emplace_back(
      "context_size", static_cast<long long>(llama_n_ctx(loader_.context())));
  stats.emplace_back("backendDevice", loader_.runtimeBackendDevice());
  return stats;
}

void LayaModel::cancel() const { stopCancelled_.store(true); }

void LayaModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  loader_.setWeightsForFile(filename, std::move(shard));
}

void LayaModel::initializeBackend(
    const std::string& backendsDir, const std::string& openclCacheDir) {
  loader_.initializeBackend(backendsDir, openclCacheDir);
}

bool LayaModel::isLoaded() const {
  return loader_.isLoaded() && laya_ != nullptr;
}

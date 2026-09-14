#include "model-interface/FitToFreeDeviceMemory.hpp"

#include <algorithm>
#include <cstdio>
#include <iterator>
#include <limits>
#include <mutex>
#include <vector>

#include <common/log.h>

#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

namespace fit_to_free_device_memory {

namespace {

/// Whether the fitter can read @p modelPath at all.
///
/// Not a convenience check. `common_fit_params` segfaults on a path it cannot
/// open: `gguf_init_from_file` logs the failure but the fit path then
/// dereferences the null model. packages/model-fit guards its own call the same
/// way (addon/src/fit/FitParams.cpp). This addon's own existence check does not
/// happen until `initFromConfig`, which is after the fit, so the guard has to
/// be here.
bool modelIsReadable(const std::string& modelPath) {
  if (modelPath.empty()) {
    return false;
  }
  // `fopen` rather than `std::filesystem::exists`: the question is whether the
  // fitter can read the bytes, not whether a directory entry exists. A path
  // that exists but cannot be opened crashes it just the same.
  FILE* handle = std::fopen(modelPath.c_str(), "rb");
  if (handle == nullptr) {
    return false;
  }
  std::fclose(handle);
  return true;
}

} // namespace

LlamaFitInvoker productionInvoker() {
  return [](const char* pathModel,
            llama_model_params* mparams,
            llama_context_params* cparams,
            float* tensorSplit,
            llama_model_tensor_buft_override* buftOverrides,
            size_t* margins,
            uint32_t nCtxMin,
            bool prefetchWeightsAuto,
            ggml_log_level logLevel) {
    return common_fit_params(
        pathModel,
        mparams,
        cparams,
        tensorSplit,
        buftOverrides,
        margins,
        nCtxMin,
        prefetchWeightsAuto,
        logLevel);
  };
}

FitOutcome fitParamsToFreeDeviceMemory(
    common_params& params, const std::string& modelPath,
    const LlamaFitInvoker& invoker) {
  FitOutcome outcome;

  // The caller asked for no fit. QVAC-24253 clears this for `split-mode:
  // tensor`, where fabric cannot fit at all, precisely to suppress the spurious
  // "failed to fit params to free device memory" WARN — so this has to be a
  // hard skip, not a best-effort attempt.
  if (!params.fit_params) {
    return outcome;
  }

  if (!modelIsReadable(modelPath)) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[LlamaModel] skipping automatic placement: no readable model "
            "file at \"%s\"\n",
            modelPath.c_str()));
    return outcome;
  }

  // `common_model_params_to_llama` asserts that a non-empty override list ends
  // in a null entry and aborts the process otherwise. Normalise rather than let
  // an unterminated list take the process down.
  if (!params.tensor_buft_overrides.empty() &&
      params.tensor_buft_overrides.back().pattern != nullptr) {
    params.tensor_buft_overrides.push_back({nullptr, nullptr});
  }

  llama_model_params mparams = common_model_params_to_llama(params);
  llama_context_params cparams = common_context_params_to_llama(params);

  // Scratch, not the `params`-owned buffers. The fitter writes its candidate
  // placement into these on every probe of its descent search, not only on the
  // one it settles on, and when it gives up it restores the two structs but not
  // the buffers they point at — so fitting in place would leave a rejected
  // placement, or every MoE expert pinned to CPU, in `params` for the load
  // below to pick up. Seeded from `params` so a field the fitter never writes
  // (tensor_split with a single device) still round-trips the caller's value.
  const size_t maxDevices = llama_max_devices();
  std::vector<float> tensorSplit(
      std::begin(params.tensor_split),
      std::begin(params.tensor_split) + maxDevices);
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  std::copy_n(
      params.tensor_buft_overrides.begin(),
      std::min(params.tensor_buft_overrides.size(), buftOverrides.size()),
      buftOverrides.begin());

  // `common/fit.h`: `common_fit_params` "is NOT thread safe because it modifies
  // the global llama logger state" — it installs a pointer to one of its own
  // stack frames as the process-global log user_data for the duration of the
  // call. This guards the call, not the load: unlike @qvac/model-fit, which
  // serialises whole fits behind `g_fitMutex`, this addon keeps many models
  // alive concurrently and cannot serialise their loads.
  static std::mutex
      fitMutex; // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

  // The fitter restores the logger on the way out, but not exception-safely:
  // it throws from inside that window and the handler in `common_fit_params`
  // maps the throw to a status rather than putting the logger back. This addon
  // installs a process-global callback of its own (LlamaLazyInitializeBackend),
  // so without an unconditional restore every subsequent log line from every
  // live model would go through a freed frame. A no-op when the fitter did
  // restore it.
  ggml_log_callback priorLogCallback = nullptr;
  void* priorLogUserData = nullptr;

  {
    const std::lock_guard<std::mutex> fitLock(fitMutex);
    llama_log_get(&priorLogCallback, &priorLogUserData);
    outcome.invoked = true;
    outcome.status = invoker(
        modelPath.c_str(),
        &mparams,
        &cparams,
        tensorSplit.data(),
        buftOverrides.data(),
        params.fit_params_target.data(),
        static_cast<uint32_t>(params.fit_params_min_ctx),
        params.prefetch_weights_auto,
        params.verbosity >= LOG_LEVEL_DEBUG ? GGML_LOG_LEVEL_DEBUG
                                            : GGML_LOG_LEVEL_ERROR);
    llama_log_set(priorLogCallback, priorLogUserData);
  }

  if (outcome.status != COMMON_PARAMS_FIT_STATUS_SUCCESS) {
    // FAILURE means "no placement fits", and the caller's own configuration is
    // the right thing to fall back to — fabric has already logged the reason,
    // which is usually that the caller pinned one of the parameters the fitter
    // would have had to move. ERROR is an internal fault, so nothing it
    // produced is trustworthy; say so rather than let it pass as quietly as a
    // routine "does not fit".
    QLOG_IF(
        outcome.status == COMMON_PARAMS_FIT_STATUS_ERROR ? Priority::ERROR
                                                         : Priority::INFO,
        string_format(
            "[LlamaModel] automatic placement %s; loading \"%s\" as requested "
            "instead\n",
            outcome.status == COMMON_PARAMS_FIT_STATUS_ERROR
                ? "hit an internal error"
                : "found nothing to change",
            modelPath.c_str()));
    return outcome;
  }

  params.n_gpu_layers = mparams.n_gpu_layers;
  // `n_ctx` is uint32_t here and int32_t in common_params. The fitter cannot
  // currently produce a value this clamps — it only ever lowers n_ctx, and only
  // towards a trained context that already fits — so this guards a future
  // change to its bounds rather than a live narrowing bug.
  params.n_ctx = static_cast<int32_t>(std::min<uint32_t>(
      cparams.n_ctx,
      static_cast<uint32_t>(std::numeric_limits<int32_t>::max())));
  params.prefetch_weights = cparams.prefetch_weights;
  params.moe_cache_size = cparams.moe_cache_size;
  std::copy(
      tensorSplit.begin(), tensorSplit.end(), std::begin(params.tensor_split));

  // Copy only as far as the terminator. The fitter needs
  // `llama_max_tensor_buft_overrides()` writable entries while it runs, but the
  // loader reads only up to the null entry, and `params` is copied by value
  // into every per-slot context and kept for the model's lifetime.
  const auto terminator = std::find_if(
      buftOverrides.begin(),
      buftOverrides.end(),
      [](const llama_model_tensor_buft_override& candidate) {
        return candidate.pattern == nullptr;
      });
  params.tensor_buft_overrides.assign(
      buftOverrides.begin(),
      terminator == buftOverrides.end() ? terminator : terminator + 1);

  // The complaint that started QVAC-25039 was that a skipped placement was
  // indistinguishable from an applied one in the log. State what was chosen.
  QLOG_IF(
      Priority::INFO,
      string_format(
          "[LlamaModel] automatic placement applied: n_gpu_layers=%d, "
          "n_ctx=%d, %zu tensor buffer override(s)\n",
          params.n_gpu_layers,
          params.n_ctx,
          params.tensor_buft_overrides.empty()
              ? 0U
              : params.tensor_buft_overrides.size() - 1U));

  outcome.applied = true;
  return outcome;
}

} // namespace fit_to_free_device_memory

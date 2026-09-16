#include "model-interface/FitToFreeDeviceMemory.hpp"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <iterator>
#include <limits>
#include <mutex>
#include <string>
#include <system_error>
#include <vector>

#include <common/log.h>
#include <ggml.h>

#include "utils/LoggingMacros.hpp"
#include "utils/ScopeGuard.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

namespace fit_to_free_device_memory {

namespace {

/// Whether the fitter can read @p modelPath at all.
///
/// Defensive rather than crash-prevention: at the pinned fabric an unreadable
/// path is already handled — `common_get_device_memory_data_impl` null-checks
/// the load and throws (common/fit.cpp), which `common_fit_params` maps to
/// `COMMON_PARAMS_FIT_STATUS_ERROR`. What this buys is a specific warning and a
/// skipped descent search instead of an error-level report of a fault that was
/// never the fitter's.
///
/// Both steps treat @p modelPath as UTF-8, because that is what llama.cpp does
/// with it and what the addon is handed from JS. `ggml_fopen` converts with
/// `MultiByteToWideChar(CP_UTF8, …)` and opens via `_wfopen` on Windows, where
/// plain `std::fopen` would go through the active code page; and a
/// `std::filesystem::path` built from a *narrow* string is likewise interpreted
/// in the native narrow encoding, which on Windows is that same code page
/// rather than UTF-8. Going through `std::u8string` pins the filesystem check
/// to the same interpretation as the open. Getting either half wrong would
/// reject `C:\Users\Müller\models\…`, or any CJK or Cyrillic directory, skip
/// the fit and reinstate the unfitted load this file exists to prevent — and
/// `win32-x64` ships in the CI matrix.
///
/// The `is_regular_file` test comes first, not after the open, because `fopen`
/// succeeds on a directory on Linux and macOS and blocks indefinitely on a
/// FIFO; checking the already-open handle instead would reintroduce the hang.
bool modelIsReadable(const std::string& modelPath) {
  if (modelPath.empty()) {
    return false;
  }
  const std::u8string utf8Path(modelPath.begin(), modelPath.end());
  std::error_code ignored;
  if (!std::filesystem::is_regular_file(
          std::filesystem::path(utf8Path), ignored)) {
    return false;
  }
  FILE* handle = ggml_fopen(modelPath.c_str(), "rb");
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
  // an unterminated list take the process down. Note this mutates @p params
  // whatever the fit then decides — see the note on `FitOutcome::applied`.
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
  //
  // `tensor_split` is sized to the whole `common_params` array rather than to
  // `llama_max_devices()`: fabric writes one entry per *registered* device
  // (`set_ngl_tensor_split_tbo`, common/fit.cpp) and nothing truncates that
  // count to the 16-device cap, so a host with more devices than the cap would
  // write past a 16-wide buffer. Matching fabric's own call site, which passes
  // the 128-wide array, makes the buffer as wide as anything it can write.
  std::vector<float> tensorSplit(
      std::begin(params.tensor_split), std::end(params.tensor_split));
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  std::copy_n(
      params.tensor_buft_overrides.begin(),
      std::min(params.tensor_buft_overrides.size(), buftOverrides.size()),
      buftOverrides.begin());

  // `common/fit.h`: `common_fit_params` "is NOT thread safe because it modifies
  // the global llama logger state" — it installs a pointer to one of its own
  // stack frames as the process-global log user_data for the duration of the
  // call, and its inner probe repeats that save/restore on every iteration, so
  // two concurrent fits would corrupt each other's chain. The lock therefore
  // cannot be narrowed below the whole call.
  //
  // Cost model, because it is not free: concurrent single-file loads have their
  // fit phases fully serialised, and that window is now a complete descent
  // search rather than the single probe an unpinned load used to abort after.
  // It is still strictly safer than the status quo, where the same fit ran from
  // `common_init_from_params` with no lock at all. Removing the serialisation
  // needs thread-local logger state in fabric.
  //
  // Narrower than @qvac/model-fit's `g_fitMutex`, which guards whole fits:
  // `FitParams.cpp` notes that this addon keeps many models alive concurrently
  // and therefore cannot serialise their loads.
  static std::mutex
      fitMutex; // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

  {
    const std::lock_guard<std::mutex> fitLock(fitMutex);

    // The fitter restores the logger on the way out, but not exception-safely:
    // it throws from inside that window and the handler in `common_fit_params`
    // maps the throw to a status rather than putting the logger back. This
    // addon installs a process-global callback of its own
    // (LlamaLazyInitializeBackend), so anything left behind would send every
    // later log line from every live model through a freed frame. The guard
    // rather than a trailing call, so an exception escaping the invoker — a
    // `std::bad_function_call` from an empty seam, or a test double — cannot
    // skip it. A no-op when the fitter did restore it.
    ggml_log_callback priorLogCallback = nullptr;
    void* priorLogUserData = nullptr;
    llama_log_get(&priorLogCallback, &priorLogUserData);
    ScopeGuard loggerGuard(
        [priorLogCallback, priorLogUserData] {
          llama_log_set(priorLogCallback, priorLogUserData);
        },
        "fit-logger-restore");

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
  }

  if (outcome.status != COMMON_PARAMS_FIT_STATUS_SUCCESS) {
    // WARNING, not INFO: this library's default verbosity is ERROR, and
    // `LoadFitNormalization.cpp` already settled the same question the same way
    // — a notice carrying a real OOM consequence must not be invisible by
    // default. Not "found nothing to change":
    // `COMMON_PARAMS_FIT_STATUS_FAILURE` covers both "a parameter you pinned
    // stopped the fit" and "no placement fits at all" (common/fit.h), and
    // fabric has already logged which.
    QLOG_IF(
        outcome.status == COMMON_PARAMS_FIT_STATUS_ERROR ? Priority::ERROR
                                                         : Priority::WARNING,
        string_format(
            "[LlamaModel] automatic placement %s; loading \"%s\" with the "
            "configuration as given\n",
            outcome.status == COMMON_PARAMS_FIT_STATUS_ERROR
                ? "hit an internal error"
                : "did not apply (see the qvac-fabric message above for why)",
            modelPath.c_str()));
    return outcome;
  }

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
  if (terminator == buftOverrides.end()) {
    // Unreachable with the real fitter, which always writes a terminator and
    // throws rather than overflow. Reachable through the seam, and adopting an
    // unterminated list would trip `common_model_params_to_llama`'s
    // GGML_ASSERT — a process abort. Decline the result instead, which is what
    // the rest of this function does with output it cannot trust.
    QLOG_IF(
        Priority::ERROR,
        string_format(
            "[LlamaModel] automatic placement returned an unterminated "
            "override list; loading \"%s\" with the configuration as given\n",
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
  params.tensor_buft_overrides.assign(buftOverrides.begin(), terminator + 1);

  // The complaint that started QVAC-25039 was that a skipped placement was
  // indistinguishable from an applied one in the log. State what was chosen.
  // INFO rather than WARNING because this is the intended path, not an
  // override of something the caller asked for; the non-success branch above
  // is the one that has to be visible by default.
  QLOG_IF(
      Priority::INFO,
      string_format(
          "[LlamaModel] automatic placement applied: n_gpu_layers=%d, "
          "n_ctx=%d, %zu tensor buffer override(s)\n",
          params.n_gpu_layers,
          params.n_ctx,
          params.tensor_buft_overrides.size() - 1U));

  outcome.applied = true;
  return outcome;
}

} // namespace fit_to_free_device_memory

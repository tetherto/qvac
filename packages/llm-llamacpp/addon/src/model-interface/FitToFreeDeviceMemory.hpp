#pragma once

#include <functional>
#include <string>

#include <common/common.h>
#include <common/fit.h>

// TODO(QVAC-25039 follow-up): delete this header and its .cpp once
// llm-llamacpp moves to qvac-lib-inference-addon-cpp 1.5.0 (#4446 plus its
// registry publish and baseline bump). That port gains the same scratch-buffer
// fit inside `initFromConfig`, for every loader rather than just the
// single-file one, and this local copy exists only because a port change
// cannot reach this package without that republish.
namespace fit_to_free_device_memory {

/// @brief Seam over qvac-fabric's `common_fit_params`.
/// @note The nine-argument form; the `bool` is fabric's
/// `prefetch_weights_auto`, added in common/fit.h by qvac-fabric 10549.0.0 and
/// sitting immediately before the log level. Mirrors `LlamaFitInvoker` in
/// packages/model-fit/addon/src/fit/LlamaLoadConfig.hpp, which exists for the
/// same reason: the fitter reads a real GGUF and walks the real device
/// registry, so it is unreachable from a unit test unless it can be replaced.
using LlamaFitInvoker = std::function<common_params_fit_status(
    const char*, llama_model_params*, llama_context_params*, float*,
    llama_model_tensor_buft_override*, size_t*, uint32_t, bool,
    ggml_log_level)>;

/// @brief Forwards straight to `common_fit_params`.
LlamaFitInvoker productionInvoker();

/// @brief What `fitParamsToFreeDeviceMemory` did, for logging and tests.
struct FitOutcome {
  /// The fitter was actually called. False when the fit was skipped, in which
  /// case `status` is meaningless.
  bool invoked = false;
  common_params_fit_status status = COMMON_PARAMS_FIT_STATUS_ERROR;
  /// The fit succeeded and its placement was folded into `params`. No
  /// *placement* is written when this is false — but `tensor_buft_overrides`
  /// may still have been normalised in place, since an unterminated override
  /// list has to be terminated before the fitter can be handed it at all.
  bool applied = false;
};

/// @brief Runs qvac-fabric's automatic GPU/CPU placement (`--fit`) for a model
/// about to be loaded, and folds the result into @p params.
/// @param params Load configuration; updated in place **only** on a successful
/// fit.
/// @param modelPath The GGUF the fitter reads the model shape from.
/// @param invoker The fitter. Defaults to `common_fit_params`.
///
/// @note Why this exists rather than letting `common_init_from_params` fit in
/// place: fabric runs the same fitter against `params`' own buffers and then
/// discards the status (common/common.cpp, `common_init_result`). Two things
/// follow. A caller that set no override of its own handed the fitter a null
/// `tensor_buft_overrides` — fabric pads that vector in
/// `common_params_parse_ex` (common/arg.cpp), so a consumer reaching fabric
/// through `common_params_parse` was covered, but this addon builds its
/// `common_params` by hand via `common_params_parser_init` plus its own handler
/// dispatch and was not — so the fit aborted at its first precondition and
/// models loaded unfitted with nothing in the log to say so. And
/// `common_fit_params` restores the two parameter structs when it gives up but
/// not the buffers they point at, while writing a candidate placement into
/// those buffers on every probe of its descent search — so fitting in place
/// could hand the load a placement the fitter had explicitly rejected, or every
/// MoE expert pinned to CPU.
///
/// @note Fits against scratch buffers and adopts them only on `SUCCESS`, so a
/// fit that fails or errors leaves the load to proceed with exactly the
/// configuration the caller asked for. Mirrors
/// packages/model-fit/addon/src/fit/LlamaLoadConfig.cpp's `invokeLlamaFit`.
///
/// @note Every field the fitter can move — `n_gpu_layers`, `n_ctx`,
/// `prefetch_weights`, `moe_cache_size`, `tensor_split` and
/// `tensor_buft_overrides` — carries its decision afterwards, so @p params
/// describes the configuration the load will use rather than the one that was
/// requested. Anything derived from @p params for reporting should be derived
/// after this call, so the two agree.
/// @note The caller must also clear `params.fit_params` before handing @p
/// params to `common_init_from_params`, or fabric will run the fit a second
/// time in place and discard its status.
FitOutcome fitParamsToFreeDeviceMemory(
    common_params& params, const std::string& modelPath,
    const LlamaFitInvoker& invoker = productionInvoker());

} // namespace fit_to_free_device_memory

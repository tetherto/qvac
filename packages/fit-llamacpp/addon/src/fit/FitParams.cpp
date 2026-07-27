#include "fit/FitParams.hpp"

#include <cstdio>
#include <stdexcept>

#include <llama.h>

namespace fit_llamacpp {

FitResult runFit(const FitRequest& req) {
  if (req.modelPath.empty()) {
    throw std::invalid_argument("fit-llamacpp: modelPath is required");
  }

  FitResult out;
  // DIAGNOSTIC (temporary): fflush'd markers to locate the win32 crash. On
  // Windows CI stderr is block-buffered (piped), so llama_params_fit's own logs
  // are lost on a hard crash; these explicit flushes survive.
  std::fprintf(stderr, "[fit-diag] runFit: entered\n");
  std::fflush(stderr);
  const size_t maxDevices = llama_max_devices();
  out.maxDevices = maxDevices;
  std::fprintf(stderr, "[fit-diag] runFit: maxDevices=%zu\n", maxDevices);
  std::fflush(stderr);

  // `llama_params_fit` segfaults on a path it cannot open: gguf_init_from_file
  // logs the failure but the fit path then dereferences the null model. Guard
  // it here so an unreadable/missing model is reported as a clean ERROR (the
  // documented outcome) instead of crashing the worklet.
  if (std::FILE* f = std::fopen(req.modelPath.c_str(), "rb")) {
    std::fclose(f);
  } else {
    out.status = static_cast<int>(LLAMA_PARAMS_FIT_STATUS_ERROR);
    out.fits = false;
    return out;
  }

  llama_model_params mparams = llama_model_default_params();
  llama_context_params cparams = llama_context_default_params();

  // `llama_params_fit` only rewrites fields that still hold their default
  // value, so pin a field only when the caller explicitly requested one.
  if (req.nGpuLayers != kGpuLayersAuto) {
    mparams.n_gpu_layers = req.nGpuLayers;
  }
  // n_ctx is the documented exception: the fitter reduces it iff it is 0.
  // A concrete request is therefore a hard constraint to fit around.
  cparams.n_ctx = req.nCtx;
  if (req.nBatch != 0) {
    cparams.n_batch = req.nBatch;
  }
  if (req.nUbatch != 0) {
    cparams.n_ubatch = req.nUbatch;
  }

  // Writable scratch buffers the fit API requires. Sizes are dictated by the
  // library, not the caller.
  std::vector<float> tensorSplit(maxDevices, 0.0F);
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  std::vector<size_t> margins(
      maxDevices,
      static_cast<size_t>(req.marginMiB) * 1024ULL * 1024ULL);

  std::fprintf(
      stderr,
      "[fit-diag] runFit: calling llama_params_fit (nCtx=%u nCtxMin=%u "
      "ngl=%d marginMiB=%u bufts=%zu)\n",
      cparams.n_ctx,
      req.nCtxMin,
      mparams.n_gpu_layers,
      req.marginMiB,
      buftOverrides.size());
  std::fflush(stderr);

  const llama_params_fit_status status = llama_params_fit(
      req.modelPath.c_str(),
      &mparams,
      &cparams,
      tensorSplit.data(),
      buftOverrides.data(),
      margins.data(),
      req.nCtxMin,
      GGML_LOG_LEVEL_INFO);

  std::fprintf(
      stderr, "[fit-diag] runFit: llama_params_fit returned status=%d\n",
      static_cast<int>(status));
  std::fflush(stderr);

  out.status = static_cast<int>(status);
  out.fits = (status == LLAMA_PARAMS_FIT_STATUS_SUCCESS);
  out.nGpuLayers = mparams.n_gpu_layers;
  out.nCtx = cparams.n_ctx;
  out.nBatch = cparams.n_batch;
  out.nUbatch = cparams.n_ubatch;
  out.tensorSplit.assign(tensorSplit.begin(), tensorSplit.end());
  return out;
}

}  // namespace fit_llamacpp

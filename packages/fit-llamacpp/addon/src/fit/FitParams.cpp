#include "fit/FitParams.hpp"

#include <cstdio>
#include <stdexcept>

#include <llama.h>

#ifdef _WIN32
#include <excpt.h> // __try/__except, GetExceptionCode, EXCEPTION_EXECUTE_HANDLER
#endif

namespace fit_llamacpp {

namespace {

#ifdef _WIN32
// On some Windows GPU configurations `llama_params_fit` hits an integer
// divide-by-zero (SEH 0xC0000094) deep in the fit math — an upstream llama.cpp
// bug where a device/layer count comes back 0 on Windows but not elsewhere. It
// is a *hardware* trap, so the library's own C++ try/catch (which turns error
// paths into FAILURE/ERROR) cannot catch it and the process dies. Run the call
// in a leaf frame with no unwindable C++ objects so we can SEH-catch the trap
// and report the documented ERROR outcome ("unknown → proceed advisory-only")
// instead of crashing the worklet. Normal SUCCESS/FAILURE/ERROR results still
// come back through llama_params_fit's own return value; only a fatal trap
// takes the __except path.
int fitSehFilter(unsigned long code) {
  std::fprintf(
      stderr,
      "fit-llamacpp: llama_params_fit raised a fatal native exception 0x%08lx; "
      "reporting ERROR (projection unavailable on this platform)\n",
      code);
  std::fflush(stderr);
  return EXCEPTION_EXECUTE_HANDLER;
}

bool callLlamaParamsFitGuarded(
    const char* pathModel, llama_model_params* mparams,
    llama_context_params* cparams, float* tensorSplit,
    llama_model_tensor_buft_override* buftOverrides, size_t* margins,
    uint32_t nCtxMin, llama_params_fit_status* outStatus) {
  __try {
    *outStatus = llama_params_fit(
        pathModel,
        mparams,
        cparams,
        tensorSplit,
        buftOverrides,
        margins,
        nCtxMin,
        GGML_LOG_LEVEL_INFO);
    return true;
  } __except (fitSehFilter(GetExceptionCode())) {
    return false;
  }
}
#endif

} // namespace

FitResult runFit(const FitRequest& req) {
  if (req.modelPath.empty()) {
    throw std::invalid_argument("fit-llamacpp: modelPath is required");
  }

  FitResult out;
  const size_t maxDevices = llama_max_devices();
  out.maxDevices = maxDevices;

  // `llama_params_fit` segfaults on a path it cannot open: gguf_init_from_file
  // logs the failure but the fit path then dereferences the null model. Guard
  // it here so an unreadable/missing model is reported as a clean ERROR (the
  // documented outcome) instead of crashing the worklet.
  if (std::FILE* f = std::fopen(req.modelPath.c_str(), "rb")) {
    std::fclose(f);
  } else {
    out.status = static_cast<int>(LLAMA_PARAMS_FIT_STATUS_ERROR);
    out.fits = false;
    out.tensorSplit.assign(maxDevices, 0.0F);
    return out;
  }

  llama_model_params mparams = llama_model_default_params();
  llama_context_params cparams = llama_context_default_params();

  // `llama_params_fit` only rewrites fields that still hold their default
  // value, so pin a field only when the caller explicitly requested one.
  if (req.nGpuLayers != GPU_LAYERS_AUTO) {
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
      maxDevices, static_cast<size_t>(req.marginMiB) * 1024ULL * 1024ULL);

  llama_params_fit_status status = LLAMA_PARAMS_FIT_STATUS_ERROR;

#ifdef _WIN32
  if (!callLlamaParamsFitGuarded(
          req.modelPath.c_str(),
          &mparams,
          &cparams,
          tensorSplit.data(),
          buftOverrides.data(),
          margins.data(),
          req.nCtxMin,
          &status)) {
    // A fatal native trap was contained: report ERROR (projection unavailable).
    out.status = static_cast<int>(LLAMA_PARAMS_FIT_STATUS_ERROR);
    out.fits = false;
    out.tensorSplit.assign(tensorSplit.begin(), tensorSplit.end());
    return out;
  }
#else
  status = llama_params_fit(
      req.modelPath.c_str(),
      &mparams,
      &cparams,
      tensorSplit.data(),
      buftOverrides.data(),
      margins.data(),
      req.nCtxMin,
      GGML_LOG_LEVEL_INFO);
#endif

  out.status = static_cast<int>(status);
  out.fits = (status == LLAMA_PARAMS_FIT_STATUS_SUCCESS);
  out.nGpuLayers = mparams.n_gpu_layers;
  out.nCtx = cparams.n_ctx;
  out.nBatch = cparams.n_batch;
  out.nUbatch = cparams.n_ubatch;
  out.tensorSplit.assign(tensorSplit.begin(), tensorSplit.end());
  return out;
}

} // namespace fit_llamacpp

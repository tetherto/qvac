#include "fit/FitParams.hpp"

#include <cstdio>
#include <filesystem>
#include <mutex>
#include <stdexcept>

#include <ggml-backend.h>
#include <gguf.h>
#include <llama.h>

namespace model_fit {

namespace {

/// Serialises whole fit calls.
///
/// `llama.h` states that `llama_params_fit` "is NOT thread safe because it
/// modifies the global llama logger state", so two concurrent fits are unsafe
/// no matter how the backend is managed. Bare runs JS single-threaded per
/// worklet, but this addon's C++ statics are shared across every worklet in the
/// process, so nothing else prevents two of them calling in at once.
///
/// Holding this for the entire call also means two BackendScopes can never
/// overlap, which is what makes the unconditional init/free below safe without
/// the reference counting @qvac/llm-llamacpp needs (it keeps many models alive
/// concurrently and therefore cannot serialise).
std::mutex
    g_fitMutex; // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

/// Owns the ggml/llama backend lifecycle for one fit call.
///
/// `llama_params_fit` does not load backends — it only reads ggml's global
/// device registry, so whatever is registered when it runs *is* its entire view
/// of the machine. Registration is the application's job: statically linked
/// backends self-register when the registry is first constructed, but backends
/// shipped as separate shared libraries must be loaded explicitly. Upstream's
/// own `tools/fit-params` relies on `llama_backend_init()` for this.
///
/// Skipping it happens to work on a static build and silently produces a
/// projection against an empty device list on a dynamic one, so do it properly:
/// load the packaged backends when we were told where they are, otherwise fall
/// back to ggml's default search path, then hand off to `llama_backend_init()`.
/// The explicit load keeps this correct regardless of whether the linked llama
/// build performs its own guarded load.
class BackendScope {
public:
  explicit BackendScope(const std::string& backendsDir) {
    if (!backendsDir.empty()) {
      std::filesystem::path backendsPath(backendsDir);
#ifdef BACKENDS_SUBDIR
      backendsPath = (backendsPath / std::filesystem::path(BACKENDS_SUBDIR))
                         .lexically_normal();
#endif
      ggml_backend_load_all_from_path(backendsPath.string().c_str());
    } else if (ggml_backend_reg_count() == 0) {
      ggml_backend_load_all();
    }

    llama_backend_init();
    // Upstream's tools/fit-params calls this immediately after backend init.
    // DISABLED is the llama default and keeps NUMA behaviour explicit rather
    // than inherited.
    llama_numa_init(GGML_NUMA_STRATEGY_DISABLED);
  }

  ~BackendScope() { llama_backend_free(); }

  BackendScope(const BackendScope&) = delete;
  BackendScope& operator=(const BackendScope&) = delete;
  BackendScope(BackendScope&&) = delete;
  BackendScope& operator=(BackendScope&&) = delete;
};

/// Reads the model's trained context length straight from GGUF metadata.
///
/// When the caller passes `nCtx == 0` the fitter is free to choose, and llama
/// encodes "use the trained context" as a context of 0 — so a successful plan
/// can come back holding 0, which is not a context any caller can act on. Read
/// the real value so a SUCCESS always carries a concrete number.
///
/// `kv_only` stops parsing after the KV block, so no tensor data is read and
/// the addon's no-weights-loaded promise still holds. Returns 0 when the file
/// or the key cannot be read, leaving the caller no worse off than before.
uint32_t readTrainedContext(const std::string& modelPath) {
  gguf_init_params params = {};
  params.no_alloc = true;
  params.ctx = nullptr;
  params.kv_only = true;

  gguf_context* ctx = gguf_init_from_file(modelPath.c_str(), params);
  if (ctx == nullptr) {
    return 0;
  }

  uint32_t trained = 0;
  const int64_t archId = gguf_find_key(ctx, "general.architecture");
  if (archId >= 0 && gguf_get_kv_type(ctx, archId) == GGUF_TYPE_STRING) {
    const std::string ctxKey =
        std::string(gguf_get_val_str(ctx, archId)) + ".context_length";
    const int64_t ctxId = gguf_find_key(ctx, ctxKey.c_str());
    if (ctxId >= 0 && gguf_get_kv_type(ctx, ctxId) == GGUF_TYPE_UINT32) {
      trained = gguf_get_val_u32(ctx, ctxId);
    }
  }

  gguf_free(ctx);
  return trained;
}

/// Counts registered devices, splitting out accelerators. Integrated GPUs count
/// as accelerators — on phones and APUs that is the only GPU there is.
void countDevices(size_t& nDevices, size_t& nGpuDevices) {
  nDevices = ggml_backend_dev_count();
  nGpuDevices = 0;
  for (size_t i = 0; i < nDevices; ++i) {
    const enum ggml_backend_dev_type type =
        ggml_backend_dev_type(ggml_backend_dev_get(i));
    if (type == GGML_BACKEND_DEVICE_TYPE_GPU ||
        type == GGML_BACKEND_DEVICE_TYPE_IGPU) {
      ++nGpuDevices;
    }
  }
}

} // namespace

FitResult runFit(const FitRequest& req) {
  // Held for the whole call — see g_fitMutex. Concurrent callers block rather
  // than corrupt the global logger state the fitter installs.
  const std::lock_guard<std::mutex> fitLock(g_fitMutex);

  if (req.modelPath.empty()) {
    throw std::invalid_argument("model-fit: modelPath is required");
  }

  FitResult out;
  const size_t maxDevices = llama_max_devices();
  out.maxDevices = maxDevices;

  // Register backends before anything queries device memory. Held for the whole
  // call so the registry cannot be torn down underneath the fitter.
  const BackendScope backends(req.backendsDir);
  countDevices(out.nDevices, out.nGpuDevices);

  // No registered device means backend loading failed outright. The fitter
  // would still return a verdict, computed against a machine it cannot see, so
  // report the documented unknown outcome instead of a confident wrong answer.
  if (out.nDevices == 0) {
    out.status = static_cast<int>(LLAMA_PARAMS_FIT_STATUS_ERROR);
    out.fits = false;
    out.reason = FitReason::NoBackendDevice;
    out.tensorSplit.assign(maxDevices, 0.0F);
    return out;
  }

  // `llama_params_fit` segfaults on a path it cannot open: gguf_init_from_file
  // logs the failure but the fit path then dereferences the null model. Guard
  // it here so an unreadable/missing model is reported as a clean ERROR (the
  // documented outcome) instead of crashing the worklet.
  if (std::FILE* f = std::fopen(req.modelPath.c_str(), "rb")) {
    std::fclose(f);
  } else {
    out.status = static_cast<int>(LLAMA_PARAMS_FIT_STATUS_ERROR);
    out.fits = false;
    out.reason = FitReason::ModelUnreadable;
    out.tensorSplit.assign(maxDevices, 0.0F);
    return out;
  }

  // Read once: bounds the request below, and resolves a fitted 0 further down.
  const uint32_t trainedCtx = readTrainedContext(req.modelPath);

  // Refuse a context the model does not declare it can serve.
  //
  // llama.cpp itself only warns here, because a caller can extend the usable
  // context past training with RoPE scaling. This addon exposes none of those
  // knobs, so the only extension reachable through it is the model's own — and
  // a YaRN-extended model already reports the extended figure as
  // `context_length`, keeping the pre-extension value in
  // `rope.scaling.original_context_length`. Bounding by `context_length`
  // therefore allows everything this API can legitimately ask for.
  //
  // NOTE: revisit if RoPE scaling parameters are ever exposed — at that point
  // a caller could legitimately exceed this and the bound becomes wrong.
  //
  // This is a guard against nonsense input, not a fix for the abort documented
  // in the README: that is KV-cache placement failing, which a large model on a
  // small device can still reach at an entirely ordinary context.
  if (trainedCtx > 0 && req.nCtx > trainedCtx) {
    throw std::invalid_argument(
        "model-fit: nCtx " + std::to_string(req.nCtx) +
        " exceeds the context length the model declares (" +
        std::to_string(trainedCtx) + ")");
  }

  llama_model_params mparams = llama_model_default_params();
  llama_context_params cparams = llama_context_default_params();

  // `llama_params_fit` only rewrites fields that still hold their default
  // value, so pin a field only when the caller explicitly requested one.
  if (req.hasNGpuLayers) {
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

  // Reducing towards a floor of zero could hand back a context nothing can run
  // with, so substitute a positive default when the caller left it unset.
  const uint32_t nCtxMin = req.nCtxMin != 0 ? req.nCtxMin : DEFAULT_N_CTX_MIN;

  // Writable scratch buffers the fit API requires. Sizes are dictated by the
  // library, not the caller.
  std::vector<float> tensorSplit(maxDevices, 0.0F);
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  std::vector<size_t> margins(
      maxDevices, static_cast<size_t>(req.marginMiB) * 1024ULL * 1024ULL);

  const llama_params_fit_status status = llama_params_fit(
      req.modelPath.c_str(),
      &mparams,
      &cparams,
      tensorSplit.data(),
      buftOverrides.data(),
      margins.data(),
      nCtxMin,
      GGML_LOG_LEVEL_INFO);

  out.status = static_cast<int>(status);
  out.fits = (status == LLAMA_PARAMS_FIT_STATUS_SUCCESS);
  out.reason = out.fits
                   ? FitReason::Fits
                   : (status == LLAMA_PARAMS_FIT_STATUS_FAILURE
                          ? FitReason::DoesNotFit
                          // The fitter ran but reported a hard error of its
                          // own. Nothing narrower is available from the C API.
                          : FitReason::ModelUnreadable);
  out.nGpuLayers = mparams.n_gpu_layers;
  out.nCtx = cparams.n_ctx;
  out.nBatch = cparams.n_batch;
  out.nUbatch = cparams.n_ubatch;
  out.tensorSplit.assign(tensorSplit.begin(), tensorSplit.end());

  // Every remaining field the fitter was free to rewrite. These went in at their
  // llama defaults, which is exactly the condition under which `llama_params_fit`
  // modifies a parameter, so reading them back is what makes the plan
  // reproducible: a caller that loads with its own defaults instead of these can
  // silently get different placement than the one that was projected to fit.
  out.splitMode = static_cast<int32_t>(mparams.split_mode);
  out.mainGpu = mparams.main_gpu;
  out.typeK = static_cast<int32_t>(cparams.type_k);
  out.typeV = static_cast<int32_t>(cparams.type_v);
  out.flashAttnType = static_cast<int32_t>(cparams.flash_attn_type);

  // Surface the placement the projection depended on. The array is terminated
  // by a null pattern; anything before that is an override the real load has to
  // apply for the plan to mean what it says.
  for (const auto& override : buftOverrides) {
    if (override.pattern == nullptr) {
      break;
    }
    out.buftOverrides.push_back(
        {override.pattern,
         override.buft != nullptr ? ggml_backend_buft_name(override.buft)
                                  : ""});
  }

  // A fit that needed no reduction leaves n_ctx at the 0 it was handed, which
  // means "the trained context" to llama but is not a plan a caller can use.
  // Resolve it so every SUCCESS carries a concrete context.
  if (out.fits && out.nCtx == 0) {
    out.nCtx = trainedCtx;
  }

  return out;
}

} // namespace model_fit

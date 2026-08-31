#include "fit/FitParams.hpp"

#include <cstdio>
#include <filesystem>
#include <iterator>
#include <mutex>
#include <stdexcept>

#include <common/fit.h>
#include <ggml-backend.h>
#include <gguf.h>
#include <llama.h>

#include "fit/FitResultContext.hpp"
#include "fit/LlamaLoadConfig.hpp"

namespace model_fit {

namespace {

/// Serialises whole fit calls.
///
/// `common/fit.h` states that `common_fit_params` "is NOT thread safe because
/// it modifies the global llama logger state", so two concurrent fits are
/// unsafe no matter how the backend is managed. Bare runs JS single-threaded
/// per worklet, but this addon's C++ statics are shared across every worklet in
/// the process, so nothing else prevents two of them calling in at once.
///
/// Holding this for the entire call also means two registrations can never
/// overlap, which is what lets the backend setup below stay unconditional
/// without the reference counting @qvac/llm-llamacpp needs (it keeps many
/// models alive concurrently and therefore cannot serialise).
std::mutex
    g_fitMutex; // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)

/// Attaches the per-device memory projection for the resolved parameters.
///
/// `common_get_device_memory_data` runs one more no-alloc probe, so this costs
/// roughly what the fit itself cost. It is evidence, not verdict: a probe
/// failure leaves `out.projection` empty and never touches `out.status` — a
/// verdict must not become ERROR because its explanation could not be
/// gathered. Called only for SUCCESS and FAILURE; a does-not-fit with numbers
/// is precisely the point, while ERROR has no resolved parameters to project.
///
/// Must run while `mparams`/`cparams` still borrow from live storage — in the
/// llama-load path `modelParams.tensor_split` points into
/// `execution.tensorSplit`, so this has to happen before that vector is moved
/// into the result.
void captureProjection(
    const std::string& modelPath, const llama_model_params& mparams,
    const llama_context_params& cparams, FitResult& out) {
  try {
    std::vector<ggml_backend_dev_t> devs;
    uint32_t hpNgl = 0;
    uint32_t hpNctTrain = 0;
    uint32_t hpNexpert = 0;
    const common_device_memory_data_vec rows = common_get_device_memory_data(
        modelPath.c_str(),
        &mparams,
        &cparams,
        devs,
        hpNgl,
        hpNctTrain,
        hpNexpert,
        GGML_LOG_LEVEL_INFO);
    // One row per device in `devs` order, then the host row.
    if (rows.size() != devs.size() + 1) {
      return;
    }
    out.projection.reserve(rows.size());
    for (size_t i = 0; i < rows.size(); ++i) {
      const bool isHost = i == devs.size();
      const char* name =
          isHost ? "host" : ggml_backend_dev_name(devs[i]);
      out.projection.push_back(
          {name == nullptr ? "" : name,
           static_cast<uint64_t>(rows[i].total),
           static_cast<uint64_t>(rows[i].free),
           static_cast<uint64_t>(rows[i].model),
           static_cast<uint64_t>(rows[i].context),
           static_cast<uint64_t>(rows[i].compute)});
    }
  } catch (const std::exception&) {
    out.projection.clear();
  }
}

/// Resolves the directory the packaged ggml backends are loaded from.
///
/// The resolved path is handed to `ggml_backend_load_all_from_path`, which
/// scans it and `dlopen`s every backend library it finds — so it is a
/// native-code-loading sink, and the one string field in this API that reaches
/// one. Callers are expected to pass an app-controlled location (see the trust
/// note in index.d.ts), but resolve it to something concrete anyway, so what
/// gets loaded is decided here rather than by whatever the string happened to
/// mean at `dlopen` time:
///
///  - absolute only, so resolution never depends on the process working
///    directory, which nothing in a worklet controls;
///  - canonicalised, which collapses `..` and follows symlinks, so the
///    directory we scan is the real one and not an alias pointing elsewhere;
///  - must already exist as a directory, so a typo fails loudly here instead
///    of silently projecting against an empty device list.
///
/// Throws `std::invalid_argument` when any of those does not hold.
///
/// Only the directory the caller named is validated. `BACKENDS_SUBDIR` is
/// appended afterwards and is deliberately *not* required to exist: it is where
/// this package installs dynamic backends on the platforms that have them, and
/// on Apple and Windows the ggml backends are linked statically and the subdir
/// is never created (see the `(ANDROID OR UNIX) AND NOT APPLE` guard in
/// CMakeLists.txt). Demanding it would turn "nothing to load here" into a hard
/// error on exactly the platforms that need no loading.
std::filesystem::path resolveBackendsPath(const std::string& backendsDir) {
  const std::filesystem::path backendsPath(backendsDir);
  if (!backendsPath.is_absolute()) {
    throw std::invalid_argument(
        "model-fit: backendsDir must be an absolute path, got '" + backendsDir +
        "'");
  }

  std::error_code ec;
  const std::filesystem::path resolved =
      std::filesystem::canonical(backendsPath, ec);
  if (ec || !std::filesystem::is_directory(resolved, ec)) {
    throw std::invalid_argument(
        "model-fit: backendsDir is not an existing directory: '" +
        backendsPath.string() + "'");
  }

  return resolved;
}

/// Registers the ggml/llama backends this fit will be projected against.
///
/// `common_fit_params` does not load backends — it only reads ggml's global
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
///
/// There is deliberately no teardown counterpart. `llama_backend_free()` is not
/// the inverse of `llama_backend_init()`: it lowers to `ggml_quantize_free()`,
/// which releases the *process-global* IQ1/IQ2/IQ3 dequantisation tables every
/// llama consumer in the process shares. @qvac/llm-llamacpp reference-counts
/// precisely so that call cannot happen while a model is still loaded (see
/// LlamaLazyInitializeBackend.cpp). g_fitMutex orders fit calls against each
/// other and nothing more — it says nothing about a model another addon holds
/// open — so freeing here would pull those tables out from under live
/// inference. Leaving the backends registered costs nothing: ggml's registry
/// de-duplicates by reg pointer, and every fit needs the same inventory anyway.
void registerBackends(const std::string& backendsDir) {
  bool loadedFromPath = false;

  if (!backendsDir.empty()) {
    std::filesystem::path backendsPath = resolveBackendsPath(backendsDir);
#ifdef BACKENDS_SUBDIR
    backendsPath = (backendsPath / std::filesystem::path(BACKENDS_SUBDIR))
                       .lexically_normal();
#endif
    // Absent on platforms that link the backends statically — see
    // resolveBackendsPath. Nothing to load there, so fall through rather than
    // scanning a directory that does not exist.
    std::error_code ec;
    if (std::filesystem::is_directory(backendsPath, ec)) {
      ggml_backend_load_all_from_path(backendsPath.string().c_str());
      loadedFromPath = true;
    }
  }

  // Statically linked backends self-register when the registry is first
  // constructed, so a non-empty registry here means there is nothing to find.
  if (!loadedFromPath && ggml_backend_reg_count() == 0) {
    ggml_backend_load_all();
  }

  llama_backend_init();
  // Upstream's tools/fit-params calls this immediately after backend init.
  // DISABLED is the llama default and keeps NUMA behaviour explicit rather
  // than inherited.
  llama_numa_init(GGML_NUMA_STRATEGY_DISABLED);
}

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

  // Absolute only, for the reason `backendsDir` is: a relative path resolves
  // against the process working directory, which nothing in a worklet controls,
  // so the same request would mean different files depending on where the host
  // happened to be launched. index.d.ts documents the field as absolute — this
  // is where that becomes true, since ./binding.js is a public export and the
  // wrapper's check can be bypassed entirely.
  //
  // Deliberately not canonicalised, unlike backendsDir. That path is a
  // native-code-loading sink and has to be pinned to a real directory before
  // anything is dlopen'd from it; this one is only ever opened for reading, and
  // requiring it to exist here would turn the documented ERROR/model-unreadable
  // outcome into a thrown exception.
  //
  // NOTE: on Windows this is stricter than the wrapper. bare-path follows
  // Node and calls a rootless "/foo" absolute; std::filesystem does not,
  // because without a drive letter it still resolves against the current one.
  // The native answer is the correct one, and a path the wrapper lets through
  // is rejected here with the same message.
  if (!std::filesystem::path(req.modelPath).is_absolute()) {
    throw std::invalid_argument(
        "model-fit: modelPath must be an absolute path, got '" + req.modelPath +
        "'");
  }

  FitResult out;
  const size_t maxDevices = llama_max_devices();
  out.maxDevices = maxDevices;

  // Register backends before anything queries device memory. Nothing tears the
  // registry down afterwards — see registerBackends.
  registerBackends(req.backendsDir);
  countDevices(out.nDevices, out.nGpuDevices);

  // No registered device means backend loading failed outright. The fitter
  // would still return a verdict, computed against a machine it cannot see, so
  // report the documented unknown outcome instead of a confident wrong answer.
  if (out.nDevices == 0) {
    out.status = static_cast<int>(COMMON_PARAMS_FIT_STATUS_ERROR);
    out.fits = false;
    out.reason = FitReason::NoBackendDevice;
    out.tensorSplit.assign(maxDevices, 0.0F);
    return out;
  }

  // Validate the placement now that there is a machine to validate it against.
  //
  // Neither field is read by the fitter itself, so a bad placement costs
  // nothing here — it costs the caller later. llama consults them only at load,
  // and only under LLAMA_SPLIT_MODE_NONE, where it requires main_gpu to index
  // its own device list and returns no model otherwise ("invalid value for
  // main_gpu"). common_fit_params performs that load internally, so the whole
  // fit comes back as a bare ERROR/"failed to load model" — a verdict the
  // caller cannot act on and cannot distinguish from a real fit failure.
  // Rejecting here turns it back into what it is: a statement about arguments.
  // binding.cpp cannot do it, since the valid range is unknown until the
  // backends are registered.
  //
  // Only SPLIT_MODE_NONE is checked because it is the only mode under which
  // llama reads main_gpu at all. An unpinned split mode is left alone: it goes
  // in at llama's default, which is precisely the condition under which the
  // fitter is free to rewrite it, and a fitter that chooses NONE picks a
  // placement to match.
  if (req.hasSplitMode && req.splitMode == LLAMA_SPLIT_MODE_NONE) {
    const bool explicitCpuPlacement = req.hasNGpuLayers &&
                                      req.nGpuLayers == 0 && req.hasMainGpu &&
                                      req.mainGpu == -1;

    // NONE means "put the whole model on one GPU". With no GPU registered
    // there is no such device, and llama rejects every index including the
    // default 0, except for the exact CPU-only sentinel configuration.
    if (!explicitCpuPlacement && out.nGpuDevices == 0) {
      throw std::invalid_argument(
          "model-fit: splitMode NONE places the whole model on one GPU, but no "
          "GPU device is registered");
    }

    // The bound is deliberately loose. llama indexes a list it builds itself —
    // RPC servers and discrete GPUs, falling back to integrated ones only when
    // that list would otherwise be empty — which is never longer than the
    // GPU-class devices ggml registered. Bounding by that count rejects only
    // what llama could not accept, and leaves the narrower judgement to llama,
    // which knows its own list.
    if (!explicitCpuPlacement && req.hasMainGpu &&
        static_cast<size_t>(req.mainGpu) >= out.nGpuDevices) {
      throw std::invalid_argument(
          "model-fit: mainGpu " + std::to_string(req.mainGpu) +
          " is out of range (" + std::to_string(out.nGpuDevices) +
          " GPU device(s) registered)");
    }
  }

  // `common_fit_params` segfaults on a path it cannot open: gguf_init_from_file
  // logs the failure but the fit path then dereferences the null model. Guard
  // it here so an unreadable/missing model is reported as a clean ERROR (the
  // documented outcome) instead of crashing the worklet.
  if (std::FILE* f = std::fopen(req.modelPath.c_str(), "rb")) {
    std::fclose(f);
  } else {
    out.status = static_cast<int>(COMMON_PARAMS_FIT_STATUS_ERROR);
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

  // Apply the same bound to the floor the fitter reduces *towards*.
  //
  // The relationship check in the wrapper and the binding (`nCtxMin <= nCtx`)
  // only holds when `nCtx` is concrete. Left at 0 — the documented way to say
  // "you choose" — it does not apply at all, so an arbitrary floor reached
  // `common_fit_params` unchecked while the ceiling beside it was rejected.
  // Asking the fitter to stop reducing at a context the model never claims to
  // serve is the same nonsense `nCtx` is bounded for, and it feeds llama the
  // class of oversized context the bound above exists to keep away from it.
  //
  // Only an *explicit* floor is rejected. `DEFAULT_N_CTX_MIN` is this package's
  // value rather than the caller's, and it sits above the declared context of
  // any model trained shorter than 4096 (the bundled stories260K declares
  // 2048), so throwing on it would reject an ordinary call over a default
  // nobody passed. Clamp it instead — which is also what makes it a floor at
  // all: above the top of the reduction range it can never be reached, so it
  // silently constrains nothing.
  uint32_t nCtxMin = req.nCtxMin;
  if (nCtxMin == 0) {
    nCtxMin = (trainedCtx > 0 && trainedCtx < DEFAULT_N_CTX_MIN)
                  ? trainedCtx
                  : DEFAULT_N_CTX_MIN;
  } else if (trainedCtx > 0 && nCtxMin > trainedCtx) {
    throw std::invalid_argument(
        "model-fit: nCtxMin " + std::to_string(nCtxMin) +
        " exceeds the context length the model declares (" +
        std::to_string(trainedCtx) + ")");
  }

  llama_model_params mparams = llama_model_default_params();
  llama_context_params cparams = llama_context_default_params();

  // `common_fit_params` only rewrites fields that still hold their default
  // value, so pin a field only when the caller explicitly requested one.
  applyFitRequest(req, mparams, cparams);

  // Writable scratch buffers the fit API requires. Sizes are dictated by the
  // library, not the caller.
  std::vector<float> tensorSplit(maxDevices, 0.0F);
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  std::vector<size_t> margins(
      maxDevices, static_cast<size_t>(req.marginMiB) * 1024ULL * 1024ULL);

  const common_params_fit_status status = common_fit_params(
      req.modelPath.c_str(),
      &mparams,
      &cparams,
      tensorSplit.data(),
      buftOverrides.data(),
      margins.data(),
      nCtxMin,
      GGML_LOG_LEVEL_INFO);

  out.status = static_cast<int>(status);
  out.fits = (status == COMMON_PARAMS_FIT_STATUS_SUCCESS);
  out.reason = out.fits
                   ? FitReason::Fits
                   : (status == COMMON_PARAMS_FIT_STATUS_FAILURE
                          ? FitReason::DoesNotFit
                          // The fitter ran but reported a hard error of its
                          // own. Nothing narrower is available from the API.
                          : FitReason::ModelUnreadable);
  out.nGpuLayers = mparams.n_gpu_layers;
  out.nCtx = cparams.n_ctx;
  out.nBatch = cparams.n_batch;
  out.nUbatch = cparams.n_ubatch;
  out.tensorSplit.assign(tensorSplit.begin(), tensorSplit.end());

  // Every remaining field the fitter was free to rewrite. These went in at
  // their llama defaults, which is exactly the condition under which
  // `common_fit_params` modifies a parameter, so reading them back is what
  // makes the plan reproducible: a caller that loads with its own defaults
  // instead of these can silently get different placement than the one that was
  // projected to fit.
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

  // A fitted 0 means "the trained context", not a usable load plan.
  detail::finalizeFitContext(out, trainedCtx);

  if (status != COMMON_PARAMS_FIT_STATUS_ERROR) {
    captureProjection(req.modelPath, mparams, cparams, out);
  }

  return out;
}

FitResult runLlamaFit(const LlamaLoadFitRequest& req) {
  const std::lock_guard<std::mutex> fitLock(g_fitMutex);

  if (req.modelPath.empty()) {
    throw std::invalid_argument("model-fit: modelPath is required");
  }
  if (!std::filesystem::path(req.modelPath).is_absolute()) {
    throw std::invalid_argument(
        "model-fit: modelPath must be an absolute path, got '" + req.modelPath +
        "'");
  }

  FitResult out;
  if (preBackendUnsupportedLlamaLoad(req.params).has_value()) {
    out.status = static_cast<int>(COMMON_PARAMS_FIT_STATUS_ERROR);
    out.reason = FitReason::UnsupportedConfig;
    return out;
  }
  const size_t maxDevices = llama_max_devices();
  out.maxDevices = maxDevices;

  registerBackends(req.backendsDir);
  countDevices(out.nDevices, out.nGpuDevices);
  if (out.nDevices == 0) {
    out.status = static_cast<int>(COMMON_PARAMS_FIT_STATUS_ERROR);
    out.reason = FitReason::NoBackendDevice;
    out.tensorSplit.assign(maxDevices, 0.0F);
    return out;
  }

  if (std::FILE* file = std::fopen(req.modelPath.c_str(), "rb")) {
    std::fclose(file);
  } else {
    out.status = static_cast<int>(COMMON_PARAMS_FIT_STATUS_ERROR);
    out.reason = FitReason::ModelUnreadable;
    out.tensorSplit.assign(maxDevices, 0.0F);
    return out;
  }

  const uint32_t trainedCtx = readTrainedContext(req.modelPath);
  NormalizedLlamaLoad normalized = normalizeLlamaLoadConfig(
      req.loadKind,
      req.modelPath,
      req.params,
      readModelTraits(req.modelPath),
      discoverBackendDevices());
  LlamaFitExecution execution;
  const bool supported =
      withSupportedLlamaLoad(normalized, [&](common_params& params) {
        // Embedding loads pin the context before the oversize check, so an
        // oversized request is capped the way `embed-llamacpp` caps it rather
        // than rejected. Completion keeps the reject.
        if (req.loadKind == LlamaLoadKind::Embedding) {
          applyEmbeddingContextPolicy(params, trainedCtx);
        }
        if (trainedCtx > 0 && params.n_ctx > 0 &&
            static_cast<uint32_t>(params.n_ctx) > trainedCtx) {
          throw std::invalid_argument(
              "model-fit: ctx-size " + std::to_string(params.n_ctx) +
              " exceeds the context length the model declares (" +
              std::to_string(trainedCtx) + ")");
        }

        // No clamp at zero: fabric's `--ctx-size 0` handler encodes "do not
        // reduce the context" by storing `UINT32_MAX` in the `int32_t`
        // `fit_params_min_ctx` (common/arg.cpp:1455-1461, common/common.h:486),
        // so the sentinel arrives here as -1. `std::max(-1, 0)` erased it and
        // the `nCtxMin == 0` fallback below then turned the one configuration
        // that forbids reduction into a 4096 floor. The addons pass the field
        // through unclamped (LoadFitNormalization.cpp:101); do the same and let
        // the signed-to-unsigned round trip restore the sentinel. The fallback
        // still catches a genuine zero.
        uint32_t nCtxMin =
            req.nCtxMin == 0 ? static_cast<uint32_t>(params.fit_params_min_ctx)
                             : req.nCtxMin;
        if (nCtxMin == 0) {
          nCtxMin = DEFAULT_N_CTX_MIN;
        }
        if (trainedCtx > 0 && req.nCtxMin == 0 && nCtxMin > trainedCtx) {
          nCtxMin = trainedCtx;
        } else if (trainedCtx > 0 && nCtxMin > trainedCtx) {
          throw std::invalid_argument(
              "model-fit: nCtxMin " + std::to_string(nCtxMin) +
              " exceeds the context length the model declares (" +
              std::to_string(trainedCtx) + ")");
        }

        execution = invokeLlamaFit(
            req.modelPath, params, req.marginMiB, nCtxMin, common_fit_params);
      });
  if (!supported) {
    out.status = static_cast<int>(COMMON_PARAMS_FIT_STATUS_ERROR);
    out.reason = FitReason::UnsupportedConfig;
    out.tensorSplit.assign(maxDevices, 0.0F);
    return out;
  }
  const common_params_fit_status status = execution.status;
  llama_model_params& modelParams = execution.modelParams;
  llama_context_params& contextParams = execution.contextParams;

  out.status = static_cast<int>(status);
  out.fits = status == COMMON_PARAMS_FIT_STATUS_SUCCESS;
  out.reason = out.fits ? FitReason::Fits
                        : (status == COMMON_PARAMS_FIT_STATUS_FAILURE
                               ? FitReason::DoesNotFit
                               : FitReason::ModelUnreadable);
  out.nGpuLayers = modelParams.n_gpu_layers;
  out.nCtx = contextParams.n_ctx;
  out.nBatch = contextParams.n_batch;
  out.nUbatch = contextParams.n_ubatch;

  // Before the tensorSplit move below: `modelParams.tensor_split` points into
  // `execution.tensorSplit`, and the projection probe reads modelParams.
  if (status != COMMON_PARAMS_FIT_STATUS_ERROR) {
    captureProjection(req.modelPath, modelParams, contextParams, out);
  }

  out.tensorSplit = std::move(execution.tensorSplit);
  out.splitMode = static_cast<int32_t>(modelParams.split_mode);
  out.mainGpu = modelParams.main_gpu;
  out.typeK = static_cast<int32_t>(contextParams.type_k);
  out.typeV = static_cast<int32_t>(contextParams.type_v);
  out.flashAttnType = static_cast<int32_t>(contextParams.flash_attn_type);

  for (const auto& override : execution.buftOverrides) {
    if (override.pattern == nullptr) {
      break;
    }
    out.buftOverrides.push_back(
        {override.pattern,
         override.buft == nullptr ? ""
                                  : ggml_backend_buft_name(override.buft)});
  }
  detail::finalizeFitContext(out, trainedCtx);
  return out;
}

} // namespace model_fit

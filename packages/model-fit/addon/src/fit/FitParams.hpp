#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <llama.h>

namespace model_fit {

struct LlamaLoadFitRequest;

/// Floor applied when the caller leaves `nCtxMin` at 0. Reducing towards a
/// lower bound of zero would let the fitter return a context no model can run
/// with.
///
/// Matches upstream's `common_params::fit_params_min_ctx` default, so a caller
/// coming from `llama-fit-params` gets the same behaviour without passing
/// anything.
///
/// Clamped down to the model's declared context length when that is smaller,
/// since a floor above the top of the reduction range constrains nothing. An
/// explicit `nCtxMin` past the declared length is rejected instead — see
/// `runFit`.
inline constexpr uint32_t DEFAULT_N_CTX_MIN = 4096;

/// Inputs to a single memory-fit preflight. Mirrors the knobs the upstream
/// `llama-fit-params` CLI exposes, restricted to the fields the SDK needs.
struct FitRequest {
  std::string modelPath;

  /// Directory the packaged ggml backends live in. `BACKENDS_SUBDIR` is
  /// appended to it, mirroring `@qvac/llm-llamacpp`. Empty means "use ggml's
  /// default search path", which is correct for a statically linked build.
  std::string backendsDir;

  /// Desired context size. 0 => let the fitter pick (down to `nCtxMin`).
  /// A concrete value is treated as a hard requirement to fit around.
  uint32_t nCtx = 0;

  /// Lower bound the fitter may shrink the context to while freeing memory.
  /// 0 means "unset" and is replaced by `DEFAULT_N_CTX_MIN`. A concrete value
  /// is bounded by the model's declared context length, exactly as `nCtx` is.
  uint32_t nCtxMin = 0;

  /// Logical / physical batch sizes. 0 => llama default. Both feed the
  /// worst-case compute-buffer estimate.
  uint32_t nBatch = 0;
  uint32_t nUbatch = 0;

  /// GPU layers to offload, honoured only when `hasNGpuLayers` is set.
  ///
  /// Per `llama.h`, "a negative value means all layers", so negatives are valid
  /// input rather than an error. A separate flag rather than a sentinel keeps
  /// every int32 value — including INT32_MIN — usable.
  int32_t nGpuLayers = 0;

  /// Whether the caller pinned the layer count. Left unset, the field stays at
  /// its llama default and the fitter is free to choose; pinning makes it a
  /// hard constraint, since only default-valued fields get rewritten.
  bool hasNGpuLayers = false;

  // The remaining fields complete the upstream contract on the input side.
  // `common_fit_params` takes mparams/cparams as in/out and rewrites only what
  // is still default-valued, so a caller states its intended load by pinning
  // what it has already decided and leaving the rest for the fitter. Each is
  // paired with a `has*` flag rather than a sentinel because every value in the
  // field's range is legitimate — including 0, which is a valid split mode,
  // device index and ggml type.

  /// `enum llama_split_mode`: how the model splits across multiple GPUs. NONE,
  /// LAYER and TENSOR are accepted; ROW throws — fabric deprecates it and no
  /// supported backend provides the split buffers it needs.
  int32_t splitMode = 0;
  bool hasSplitMode = false;

  /// Raw ggml registry index of the device a NONE placement goes on. llama
  /// reads it only under `LLAMA_SPLIT_MODE_NONE`; LAYER, TENSOR and an
  /// UNPINNED mode all leave it inert, the last because llama's default is
  /// LAYER and the fitter never rewrites `split_mode`. Validated only when
  /// `splitMode` is pinned to NONE: out of range throws, in range but outside
  /// the supported GPU list projects CPU-only. -1 is the CPU sentinel and
  /// requires `nGpuLayers` 0 and `splitMode` NONE.
  int32_t mainGpu = 0;
  bool hasMainGpu = false;

  /// `enum ggml_type` for the K cache. A quantised KV changes how much memory
  /// the context needs, so pinning it fits against the real figure instead of
  /// llama's F16 default.
  int32_t typeK = 0;
  bool hasTypeK = false;

  /// `enum ggml_type` for the V cache. Same reasoning as `typeK`.
  int32_t typeV = 0;
  bool hasTypeV = false;

  /// `enum llama_flash_attn_type`. Alters KV/compute memory, so a caller that
  /// has already decided it should fit against that decision.
  int32_t flashAttnType = 0;
  bool hasFlashAttnType = false;

  bool swaFull = false;
  bool hasSwaFull = false;

  /// Free headroom to leave on every device, in MiB. Upstream default is 1024.
  uint32_t marginMiB = 1024;
};

void applyFitRequest(
    const FitRequest& request, llama_model_params& modelParams,
    llama_context_params& contextParams);

/// The CPU-only sentinel: 0 layers and mainGpu -1. Split mode is NOT checked
/// here because the only caller, `requiresSupportedGpu`, has already
/// established NONE before it asks; the JS entry point and binding.cpp both
/// validate the full relationship before `runFit`.
bool isExplicitCpuPlacement(const FitRequest& request);

/// Whether `request` cannot be honoured without a supported GPU. NONE places
/// the whole model on one GPU and TENSOR refuses an empty device list outright
/// (`llama_prepare_model_devices`), so both are argument errors on a host that
/// registers none — unless the request is the CPU sentinel, or its raw
/// `mainGpu` target was rejected to CPU. LAYER loads on the host when handed
/// no device, and an unpinned mode stays at llama's LAYER default:
/// `common_fit_params` never rewrites `split_mode`.
bool requiresSupportedGpu(const FitRequest& request, bool mainGpuRejectedToCpu);

/// Why a fit ended the way it did. `status` alone cannot distinguish an
/// unreadable model from a machine with no usable backend, which leaves the SDK
/// unable to tell "ask again later" from "never going to work".
enum class FitReason {
  /// Projected to fit; the plan is usable.
  Fits,
  /// Ran to completion and could not find a configuration that fits.
  DoesNotFit,
  /// The model path could not be opened.
  ModelUnreadable,
  /// No ggml backend registered, so there was no machine to measure.
  NoBackendDevice,
  /// The experimental load-config replica cannot represent this load reliably.
  UnsupportedConfig,
};

/// A tensor buffer-type override the fitter selected. The projection may depend
/// on this placement, so a caller reproducing the plan has to apply it too.
struct BuftOverride {
  std::string pattern;
  std::string bufferType;
};

/// Result of `runFit`. `status` mirrors `enum common_params_fit_status`
/// (0 SUCCESS, 1 FAILURE, 2 ERROR). The remaining fields carry the fitted
/// "load plan" the SDK can hand to the LLM addon.
struct FitResult {
  int status = 2;
  bool fits = false;

  /// Narrows `status` into something the caller can branch on.
  FitReason reason = FitReason::NoBackendDevice;

  /// Placement the fitter chose. Empty when it needed none. A `SUCCESS` that
  /// carries overrides is only reproducible if the real load applies them too.
  std::vector<BuftOverride> buftOverrides;
  int32_t nGpuLayers = 0;
  uint32_t nCtx = 0;
  uint32_t nBatch = 0;
  uint32_t nUbatch = 0;
  /// Offload proportions, one entry per device (`llama_max_devices()`).
  std::vector<float> tensorSplit;

  // The remaining plan fields are handed to the fitter at their llama defaults,
  // which is precisely the condition under which it may rewrite them
  // ("only parameters that have the same value as in llama_default_model_params
  // are modified", common/fit.h). They are therefore part of the plan whether
  // or not a given upstream revision happens to touch them: a caller
  // reproducing the projection has to load with these values, not with its own
  // defaults.

  /// `enum llama_split_mode` — how the model is split across multiple GPUs.
  int32_t splitMode = 0;
  /// 0 for a GPU plan (the ordinal of the one-device list under NONE; inert
  /// under LAYER and TENSOR), -1 for any CPU-only plan. Set by
  /// `normalizePlanPlacement`, so a SUCCESS never echoes a raw input index.
  int32_t mainGpu = -1;
  /// `enum ggml_type` for the K cache. Changes KV memory, so it changes the
  /// fit.
  int32_t typeK = 0;
  /// `enum ggml_type` for the V cache. Changes KV memory, so it changes the
  /// fit.
  int32_t typeV = 0;
  /// `enum llama_flash_attn_type` — alters KV/compute memory, so it too is
  /// load-bearing for the projection.
  int32_t flashAttnType = 0;

  /// Upper bound on addressable devices (`llama_max_devices()`). This is a
  /// build-time constant, NOT a count of what was detected — do not treat a
  /// nonzero value as evidence that any device was found.
  size_t maxDevices = 0;

  /// Devices actually registered after backend init
  /// (`ggml_backend_dev_count()`). Zero means no backend registered at all,
  /// which is reported as ERROR: the fitter would otherwise "succeed" against a
  /// machine it cannot see.
  size_t nDevices = 0;

  /// Raw GPU/iGPU subset of `nDevices`; may include unsupported families.
  size_t nGpuDevices = 0;
};

/// Whether a SUCCESS plan runs entirely on the host: the fitter was handed the
/// bare device terminator, or it offloads no layer. Decided from the plan the
/// fitter returned, never from the host inventory. Always false on any other
/// status, where the fields carry no decision.
bool isCpuOnlyPlan(const FitResult& result, const ggml_backend_dev_t* devices);

/// The one placement rule for every entry point. On a SUCCESS: a GPU plan
/// reports `mainGpu` 0; a CPU-only plan reports -1 and, unless the caller
/// pinned them, split mode NONE and zero layers. Other statuses are left as the
/// fitter returned them.
void normalizePlanPlacement(
    FitResult& result, const ggml_backend_dev_t* devices, bool splitModePinned,
    bool nGpuLayersPinned);

/// Runs `common_fit_params` for `req`. Never loads weight data — the fitter
/// uses its internal no-alloc simulation, so this is safe to call before a real
/// model load. Does not throw for a "won't fit" (FAILURE) outcome; that is a
/// valid, reported result, as are an unreadable model and an empty device
/// registry (both ERROR).
///
/// Throws `std::invalid_argument` for arguments that cannot be acted on:
///  - a `modelPath` that is empty or relative;
///  - a `backendsDir` that is relative or does not resolve to a directory;
///  - a `mainGpu` at or past `nDevices` when `splitMode` is pinned to NONE (in
///    range but outside the supported GPU list is not an error: the projection
///    is CPU-only instead; an unpinned mode makes `mainGpu` inert, so nothing
///    is validated and nothing is narrowed);
///  - a pinned `splitMode` of ROW — see `applyFitRequest`;
///  - a pinned `splitMode` of NONE or TENSOR on a host with no supported GPU,
///    unless the request is the CPU sentinel or its raw `mainGpu` target is
///    rejected to CPU — see `requiresSupportedGpu`;
///  - an `nCtx`, or an explicitly requested `nCtxMin`, above the context
///    length the model declares.
FitResult runFit(const FitRequest& req);
FitResult runLlamaFit(const LlamaLoadFitRequest& req);

} // namespace model_fit

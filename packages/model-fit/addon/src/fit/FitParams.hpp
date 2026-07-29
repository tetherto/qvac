#pragma once

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace model_fit {


/// Floor applied when the caller leaves `nCtxMin` at 0. Reducing towards a lower
/// bound of zero would let the fitter return a context no model can run with.
///
/// Matches upstream's `common_params::fit_params_min_ctx` default, so a caller
/// coming from `llama-fit-params` gets the same behaviour without passing
/// anything.
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
  /// 0 means "unset" and is replaced by `DEFAULT_N_CTX_MIN`.
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

  /// Free headroom to leave on every device, in MiB. Upstream default is 1024.
  uint32_t marginMiB = 1024;
};

/// Result of `runFit`. `status` mirrors `enum llama_params_fit_status`
/// (0 SUCCESS, 1 FAILURE, 2 ERROR). The remaining fields carry the fitted
/// "load plan" the SDK can hand to the LLM addon.
struct FitResult {
  int status = 2;
  bool fits = false;
  int32_t nGpuLayers = 0;
  uint32_t nCtx = 0;
  uint32_t nBatch = 0;
  uint32_t nUbatch = 0;
  /// Offload proportions, one entry per device (`llama_max_devices()`).
  std::vector<float> tensorSplit;

  /// Upper bound on addressable devices (`llama_max_devices()`). This is a
  /// build-time constant, NOT a count of what was detected — do not treat a
  /// nonzero value as evidence that any device was found.
  size_t maxDevices = 0;

  /// Devices actually registered after backend init (`ggml_backend_dev_count()`).
  /// Zero means no backend registered at all, which is reported as ERROR: the
  /// fitter would otherwise "succeed" against a machine it cannot see.
  size_t nDevices = 0;

  /// Subset of `nDevices` that are accelerators (GPU or integrated GPU). Zero
  /// means the projection is host-only and carries no GPU offload information.
  size_t nGpuDevices = 0;
};

/// Runs `llama_params_fit` for `req`. Never loads weight data — the fitter uses
/// its internal no-alloc simulation, so this is safe to call before a real
/// model load. Does not throw for a "won't fit" (FAILURE) outcome; that is a
/// valid, reported result. Throws `std::invalid_argument` only for a missing
/// model path.
FitResult runFit(const FitRequest& req);

} // namespace model_fit

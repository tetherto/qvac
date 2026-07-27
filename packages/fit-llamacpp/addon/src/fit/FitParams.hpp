#pragma once

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace fit_llamacpp {

/// Sentinel meaning "caller did not pin n_gpu_layers" — leave the field at the
/// llama default so `llama_params_fit` is free to choose the layer count.
inline constexpr int32_t kGpuLayersAuto = std::numeric_limits<int32_t>::min();

/// Inputs to a single memory-fit preflight. Mirrors the knobs the upstream
/// `llama-fit-params` CLI exposes, restricted to the fields the SDK needs.
struct FitRequest {
  std::string modelPath;

  /// Desired context size. 0 => let the fitter pick (down to `nCtxMin`).
  /// A concrete value is treated as a hard requirement to fit around.
  uint32_t nCtx = 0;

  /// Lower bound the fitter may shrink the context to while freeing memory.
  uint32_t nCtxMin = 0;

  /// Logical / physical batch sizes. 0 => llama default. Both feed the
  /// worst-case compute-buffer estimate.
  uint32_t nBatch = 0;
  uint32_t nUbatch = 0;

  /// GPU layers to offload. `kGpuLayersAuto` leaves it at the llama default so
  /// the fitter can choose; any other value pins it (the fitter won't touch a
  /// non-default field).
  int32_t nGpuLayers = kGpuLayersAuto;

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
  size_t maxDevices = 0;
};

/// Runs `llama_params_fit` for `req`. Never loads weight data — the fitter uses
/// its internal no-alloc simulation, so this is safe to call before a real
/// model load. Does not throw for a "won't fit" (FAILURE) outcome; that is a
/// valid, reported result. Throws `std::invalid_argument` only for a missing
/// model path.
FitResult runFit(const FitRequest& req);

}  // namespace fit_llamacpp

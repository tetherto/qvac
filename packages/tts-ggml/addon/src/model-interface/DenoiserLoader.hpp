#pragma once

#include <memory>
#include <string>

#include <tts-cpp/lavasr/denoiser.h>

#include "addon/TTSErrors.hpp"
#include "model-interface/BackendUtils.hpp"

namespace qvac::ttsggml {

// Outcome of loadDenoiser: the denoiser (null when disabled) plus the
// runtimeStats backend codes, or the kBackend*None sentinels when no denoiser
// is loaded.
struct LoadedDenoiser {
  std::shared_ptr<tts_cpp::lavasr::Denoiser> denoiser;
  int backendDevice = kBackendDeviceNone;
  int backendId = kBackendIdNone;
};

// Denoiser::backend_name() reports "scalar" for its pure-CPU core and the ggml
// backend name otherwise, so "scalar" joins "CPU" as backend id 0.
inline int denoiserBackendIdFromName(const std::string& name) {
  return name == "scalar" ? backendIdFromName("CPU") : backendIdFromName(name);
}

// Shared LavaSR-denoiser load path for the model backends. Every engine treats
// the denoiser identically (batch-only, rate-preserving, runs before the
// enhancer), so the logic lives in one place to keep the loaders from drifting
// — the same reason loadEnhancer exists.
//
//   ggufPath      empty => denoiser disabled (returns the kBackend*None codes).
//   resolvedGpu   the engine's *resolved* device, as for loadEnhancer: a GPU
//                 engine runs the denoiser's ggml graph on the GPU
//                 (Denoiser::load n_gpu_layers > 0, which itself falls back to
//                 the ggml CPU backend when no GPU backend initialises); a CPU
//                 engine keeps the default scalar core.
//   errorContext  prefix for the InitializationFailed message on load failure.
//
// The UL-UNAS forward is implemented in qvac-fabric-speech.cpp PR #78; an
// older tts-cpp pin (pre-#78) makes Denoiser::load throw, surfacing here as a
// clean InitializationFailed error.
inline LoadedDenoiser loadDenoiser(
    const std::string& ggufPath, bool resolvedGpu,
    const std::string& errorContext) {
  LoadedDenoiser out;
  if (ggufPath.empty())
    return out;
  try {
    out.denoiser =
        tts_cpp::lavasr::Denoiser::load(ggufPath, resolvedGpu ? 1 : 0);
  } catch (const std::exception& e) {
    throw qvac_errors::createTTSError(
        qvac_errors::tts_error::InitializationFailed, errorContext + e.what());
  }
  out.backendId = denoiserBackendIdFromName(out.denoiser->backend_name());
  out.backendDevice = out.backendId == backendIdFromName("CPU")
                          ? kBackendDeviceCpu
                          : kBackendDeviceGpu;
  return out;
}

} // namespace qvac::ttsggml

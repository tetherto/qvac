#pragma once

#include <memory>
#include <string>

#include <tts-cpp/lavasr/enhancer.h>

#include "addon/TTSErrors.hpp"
#include "model-interface/BackendUtils.hpp"

namespace qvac::ttsggml {

// Outcome of loadEnhancer: the enhancer (null when disabled) plus the
// runtimeStats backend codes (backendDeviceCode / backendIdFromName), or the
// kBackend*None sentinels when no enhancer is loaded.
struct LoadedEnhancer {
  std::shared_ptr<tts_cpp::lavasr::Enhancer> enhancer;
  int backendDevice = kBackendDeviceNone;
  int backendId = kBackendIdNone;
};

// Shared LavaSR-enhancer load path for the model backends (Chatterbox +
// Supertonic behave identically here, so the logic lives in one place to keep
// the two loaders from drifting).
//
//   ggufPath      empty => enhancer disabled (returns the kBackend*None codes).
//   resolvedGpu   the engine's *resolved* device (backendDevice_ ==
//                 kBackendDeviceGpu), so an engine CPU-fallback keeps the
//                 enhancer on CPU too instead of forcing it onto the GPU.
//   errorContext  prefix for the InitializationFailed message on load failure.
inline LoadedEnhancer loadEnhancer(
    const std::string& ggufPath, bool resolvedGpu,
    const std::string& errorContext) {
  LoadedEnhancer out;
  if (ggufPath.empty())
    return out;

  tts_cpp::lavasr::EnhancerOptions opts;
  opts.use_gpu = resolvedGpu;
  try {
    out.enhancer = tts_cpp::lavasr::Enhancer::load(ggufPath, opts);
  } catch (const std::exception& e) {
    throw qvac_errors::createTTSError(
        qvac_errors::tts_error::InitializationFailed, errorContext + e.what());
  }
  out.backendDevice = backendDeviceCode(out.enhancer->backend_device());
  out.backendId = backendIdFromName(out.enhancer->backend_name());
  return out;
}

} // namespace qvac::ttsggml

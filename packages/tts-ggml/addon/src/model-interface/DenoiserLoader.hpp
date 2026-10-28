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

inline int denoiserBackendDeviceFromName(const std::string& name) {
  if (name.rfind("coreml-", 0) == 0)
    return kBackendDeviceCoreML;
  return denoiserBackendIdFromName(name) == backendIdFromName("CPU")
             ? kBackendDeviceCpu
             : kBackendDeviceGpu;
}

inline LoadedDenoiser loadDenoiser(
    const std::string& ggufPath, bool resolvedGpu,
    const std::string& errorContext,
    const tts_cpp::lavasr::CoreMLOptions& coreml = {}) {
  LoadedDenoiser out;
  const bool coremlRequested =
      !coreml.model_path.empty() || !coreml.compute_units.empty();
  if (ggufPath.empty()) {
    if (coremlRequested) {
      throw qvac_errors::createTTSError(
          qvac_errors::tts_error::InitializationFailed,
          errorContext + "Core ML requires the denoiser GGUF path");
    }
    return out;
  }
  tts_cpp::lavasr::DenoiserOptions opts;
  opts.n_gpu_layers = !coremlRequested && resolvedGpu ? 1 : 0;
  opts.coreml = coreml;
  try {
    out.denoiser = tts_cpp::lavasr::Denoiser::load(ggufPath, opts);
  } catch (const std::exception& e) {
    throw qvac_errors::createTTSError(
        qvac_errors::tts_error::InitializationFailed, errorContext + e.what());
  }
  out.backendId = denoiserBackendIdFromName(out.denoiser->backend_name());
  out.backendDevice =
      denoiserBackendDeviceFromName(out.denoiser->backend_name());
  return out;
}

} // namespace qvac::ttsggml

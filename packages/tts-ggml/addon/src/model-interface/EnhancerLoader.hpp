#pragma once

#include <memory>
#include <string>

#include <tts-cpp/lavasr/enhancer.h>

#include "addon/TTSErrors.hpp"
#include "model-interface/BackendUtils.hpp"

namespace qvac::ttsggml {

// Mirrors Enhancer::output_sample_rate() for callers that need the emitted rate
// before an enhancer exists: AddonJs bakes it into the JS output handlers at
// instance creation, before load() runs.
inline constexpr int kLavasrEnhancedSampleRate = 48000;

// Outcome of loadEnhancer: the enhancer (null when disabled) plus the
// runtimeStats backend codes (backendDeviceCode / backendIdFromName), or the
// kBackend*None sentinels when no enhancer is loaded.
struct LoadedEnhancer {
  std::shared_ptr<tts_cpp::lavasr::Enhancer> enhancer;
  int backendDevice = kBackendDeviceNone;
  int backendId = kBackendIdNone;
};

inline LoadedEnhancer loadEnhancer(
    const std::string& ggufPath, bool resolvedGpu,
    const std::string& errorContext, int vulkanDevice = 0,
    const tts_cpp::lavasr::CoreMLOptions& coreml = {}) {
  LoadedEnhancer out;
  const bool coremlRequested =
      !coreml.model_path.empty() || !coreml.compute_units.empty();
  if (ggufPath.empty()) {
    if (coremlRequested) {
      throw qvac_errors::createTTSError(
          qvac_errors::tts_error::InitializationFailed,
          errorContext + "Core ML requires the enhancer GGUF path");
    }
    return out;
  }

  tts_cpp::lavasr::EnhancerOptions opts;
  opts.use_gpu = !coremlRequested && resolvedGpu;
  opts.vulkan_device = vulkanDevice;
  opts.coreml = coreml;
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

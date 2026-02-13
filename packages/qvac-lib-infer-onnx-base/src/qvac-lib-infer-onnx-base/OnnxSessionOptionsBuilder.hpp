#pragma once

#include <onnxruntime_cxx_api.h>

#include <algorithm>

#include "OnnxConfig.hpp"

#if defined(_WIN32) || defined(_WIN64)
#include <dml_provider_factory.h>
#endif

namespace onnx_addon {

// Build session options based on config
inline Ort::SessionOptions buildSessionOptions(const SessionConfig& config) {
  Ort::SessionOptions sessionOptions;

  // Set graph optimization level (using global ONNX Runtime enum values)
  switch (config.optimization) {
    case GraphOptimizationLevel::DISABLE:
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_DISABLE_ALL);
      break;
    case GraphOptimizationLevel::BASIC:
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_ENABLE_BASIC);
      break;
    case GraphOptimizationLevel::EXTENDED:
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
      break;
    case GraphOptimizationLevel::ALL:
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_ENABLE_ALL);
      break;
  }

  // CPU-only mode
  if (config.provider == ExecutionProvider::CPU) {
    sessionOptions.SetIntraOpNumThreads(config.intraOpThreads);
    sessionOptions.SetInterOpNumThreads(config.interOpThreads);
    return sessionOptions;
  }

  // Try to set up GPU provider
  const auto providers = Ort::GetAvailableProviders();

#ifdef __ANDROID__
  if (config.provider == ExecutionProvider::AUTO_GPU ||
      config.provider == ExecutionProvider::NNAPI) {
    try {
      const bool nnapiAvailable =
          std::find(providers.begin(), providers.end(),
                    "NnapiExecutionProvider") != providers.end();

      if (nnapiAvailable) {
        uint32_t nnapiFlags = NNAPI_FLAG_USE_FP16 | NNAPI_FLAG_CPU_DISABLED;
        Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_Nnapi(
            sessionOptions, nnapiFlags));
      }
    } catch (const std::exception& /*e*/) {
      // Fall back to CPU
    }
  }

#elif defined(__APPLE__)
  if (config.provider == ExecutionProvider::AUTO_GPU ||
      config.provider == ExecutionProvider::CoreML) {
    try {
      const bool coremlAvailable =
          std::find(providers.begin(), providers.end(),
                    "CoreMLExecutionProvider") != providers.end();

      if (coremlAvailable) {
        sessionOptions.AppendExecutionProvider("CoreML");
      }
    } catch (const std::exception& /*e*/) {
      // Fall back to CPU
    }
  }

#elif defined(_WIN32) || defined(_WIN64)
  if (config.provider == ExecutionProvider::AUTO_GPU ||
      config.provider == ExecutionProvider::DirectML) {
    try {
      const bool dmlAvailable =
          std::find(providers.begin(), providers.end(),
                    "DmlExecutionProvider") != providers.end();

      if (dmlAvailable) {
        sessionOptions.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
        sessionOptions.DisableMemPattern();
        Ort::ThrowOnError(
            OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0));
      }
    } catch (const std::exception& /*e*/) {
      // Fall back to CPU
    }
  }
#endif

  // Set threading options (applies to CPU fallback as well)
  sessionOptions.SetIntraOpNumThreads(config.intraOpThreads);
  sessionOptions.SetInterOpNumThreads(config.interOpThreads);

  return sessionOptions;
}

}  // namespace onnx_addon

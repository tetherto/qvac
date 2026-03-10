#pragma once

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <sstream>
#include <string>

#include "OnnxConfig.hpp"
#include "Logger.hpp"

#ifdef __ANDROID__
#include <android/log.h>
#include <nnapi_provider_factory.h>
#define ONNX_ALOG_TAG "QVAC_ONNX"
#define ONNX_ALOG(fmt, ...) __android_log_print(ANDROID_LOG_INFO, ONNX_ALOG_TAG, fmt, ##__VA_ARGS__)
#else
#define ONNX_ALOG(fmt, ...) ((void)0)
#endif

#if defined(_WIN32) || defined(_WIN64)
#include <dml_provider_factory.h>
#endif

namespace onnx_addon {

inline std::string providerToString(ExecutionProvider provider) {
  switch (provider) {
    case ExecutionProvider::CPU:      return "CPU";
    case ExecutionProvider::AUTO_GPU: return "AUTO_GPU";
    case ExecutionProvider::NNAPI:    return "NNAPI";
    case ExecutionProvider::CoreML:   return "CoreML";
    case ExecutionProvider::DirectML: return "DirectML";
  }
  return "UNKNOWN";
}

inline std::string optimizationToString(GraphOptimizationLevel level) {
  switch (level) {
    case GraphOptimizationLevel::DISABLE:  return "DISABLE";
    case GraphOptimizationLevel::BASIC:    return "BASIC";
    case GraphOptimizationLevel::EXTENDED: return "EXTENDED";
    case GraphOptimizationLevel::ALL:      return "ALL";
  }
  return "UNKNOWN";
}

// Try to append XNNPack execution provider if available and enabled
inline void tryAppendXnnpack(Ort::SessionOptions& sessionOptions) {
  try {
    const auto providers = Ort::GetAvailableProviders();
    const bool available =
        std::find(providers.begin(), providers.end(),
                  "XnnpackExecutionProvider") != providers.end();
    if (available) {
      // XNNPACK's NHWC layout transformer creates fused nodes in the
      // com.ms.internal.nhwc domain whose schemas are not registered.
      // ORT_ENABLE_EXTENDED triggers the NhwcTransformer which produces
      // these nodes, so we must drop to BASIC when XNNPACK is active.
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_ENABLE_BASIC);
      sessionOptions.AppendExecutionProvider("XNNPACK", {});
      QLOG(logger::Priority::INFO, "[OnnxSession] XNNPack EP appended (optimization level set to BASIC)");
      ONNX_ALOG("[OnnxSession] XNNPack EP appended (optimization level set to BASIC)");
    } else {
      QLOG(logger::Priority::INFO, "[OnnxSession] XNNPack EP not available");
      ONNX_ALOG("[OnnxSession] XNNPack EP not available");
    }
  } catch (const std::exception& e) {
    QLOG(logger::Priority::WARNING,
         std::string("[OnnxSession] Failed to append XNNPack: ") + e.what());
    ONNX_ALOG("[OnnxSession] Failed to append XNNPack: %s", e.what());
  }
}

// Build session options based on config
inline Ort::SessionOptions buildSessionOptions(const SessionConfig& config) {
  Ort::SessionOptions sessionOptions;

  ONNX_ALOG("[OnnxSession] buildSessionOptions called - provider=%s, optimization=%s, enableXnnpack=%s",
            providerToString(config.provider).c_str(),
            optimizationToString(config.optimization).c_str(),
            config.enableXnnpack ? "true" : "false");
  QLOG(logger::Priority::INFO,
       std::string("[OnnxSession] buildSessionOptions - provider=") +
       providerToString(config.provider) + ", optimization=" +
       optimizationToString(config.optimization) + ", enableXnnpack=" +
       (config.enableXnnpack ? "true" : "false"));

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
  ONNX_ALOG("[OnnxSession] Initial optimization level set to %s",
            optimizationToString(config.optimization).c_str());

  // Execution mode
  sessionOptions.SetExecutionMode(
      config.executionMode == ExecutionMode::PARALLEL
          ? ::ExecutionMode::ORT_PARALLEL
          : ::ExecutionMode::ORT_SEQUENTIAL);

  // Memory options
  if (!config.enableMemoryPattern) {
    sessionOptions.DisableMemPattern();
  }
  if (!config.enableCpuMemArena) {
    sessionOptions.DisableCpuMemArena();
  }

  // CPU-only mode
  if (config.provider == ExecutionProvider::CPU) {
    QLOG(logger::Priority::INFO, "[OnnxSession] CPU-only mode");
    ONNX_ALOG("[OnnxSession] CPU-only mode");
    if (config.enableXnnpack) {
      ONNX_ALOG("[OnnxSession] Calling tryAppendXnnpack for CPU mode");
      tryAppendXnnpack(sessionOptions);
    } else {
      ONNX_ALOG("[OnnxSession] XNNPACK disabled in config, skipping");
    }
    sessionOptions.SetIntraOpNumThreads(config.intraOpThreads);
    sessionOptions.SetInterOpNumThreads(config.interOpThreads);
    ONNX_ALOG("[OnnxSession] Returning CPU session options");
    return sessionOptions;
  }

  // Try to set up GPU provider
  const auto providers = Ort::GetAvailableProviders();

  // Log all available providers
  {
    std::ostringstream oss;
    oss << "[OnnxSession] Available EPs: ";
    for (size_t i = 0; i < providers.size(); ++i) {
      oss << providers[i];
      if (i < providers.size() - 1) oss << ", ";
    }
    QLOG(logger::Priority::INFO, oss.str());
    ONNX_ALOG("%s", oss.str().c_str());
  }

#ifdef __ANDROID__
  if (config.provider == ExecutionProvider::AUTO_GPU ||
      config.provider == ExecutionProvider::NNAPI) {
    ONNX_ALOG("[OnnxSession] Android GPU path - checking NNAPI availability");
    try {
      const bool nnapiAvailable =
          std::find(providers.begin(), providers.end(),
                    "NnapiExecutionProvider") != providers.end();

      ONNX_ALOG("[OnnxSession] NNAPI available: %s", nnapiAvailable ? "yes" : "no");

      if (nnapiAvailable) {
        // NNAPI does not register com.ms.internal.nhwc schemas.
        // ORT_ENABLE_EXTENDED triggers the NhwcTransformer which produces
        // fused nodes in that domain, so we must drop to BASIC.
        ONNX_ALOG("[OnnxSession] Downgrading optimization to BASIC for NNAPI");
        sessionOptions.SetGraphOptimizationLevel(
            ::GraphOptimizationLevel::ORT_ENABLE_BASIC);
        uint32_t nnapiFlags = NNAPI_FLAG_USE_FP16 | NNAPI_FLAG_CPU_DISABLED;
        Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_Nnapi(
            sessionOptions, nnapiFlags));
        QLOG(logger::Priority::INFO, "[OnnxSession] NNAPI EP appended (optimization level set to BASIC)");
        ONNX_ALOG("[OnnxSession] NNAPI EP appended (optimization level set to BASIC)");
      } else {
        QLOG(logger::Priority::WARNING, "[OnnxSession] NNAPI EP not available, falling back to CPU");
        ONNX_ALOG("[OnnxSession] NNAPI EP not available, falling back to CPU");
      }
    } catch (const std::exception& e) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Failed to append NNAPI, falling back to CPU: ") + e.what());
      ONNX_ALOG("[OnnxSession] Failed to append NNAPI: %s", e.what());
    }
  } else {
    ONNX_ALOG("[OnnxSession] Android path but provider is %s, skipping NNAPI",
              providerToString(config.provider).c_str());
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
        QLOG(logger::Priority::INFO, "[OnnxSession] CoreML execution provider appended");
      } else {
        QLOG(logger::Priority::WARNING, "[OnnxSession] CoreML execution provider not available, falling back to CPU");
      }
    } catch (const std::exception& e) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Failed to append CoreML, falling back to CPU: ") + e.what());
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
        sessionOptions.SetExecutionMode(::ExecutionMode::ORT_SEQUENTIAL);
        sessionOptions.DisableMemPattern();
        Ort::ThrowOnError(
            OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0));
        QLOG(logger::Priority::INFO, "[OnnxSession] DirectML execution provider appended");
      } else {
        QLOG(logger::Priority::WARNING, "[OnnxSession] DirectML execution provider not available, falling back to CPU");
      }
    } catch (const std::exception& e) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Failed to append DirectML, falling back to CPU: ") + e.what());
    }
  }
#endif

  // XNNPack as CPU fallback accelerator alongside GPU providers
  if (config.enableXnnpack) {
    ONNX_ALOG("[OnnxSession] Calling tryAppendXnnpack as CPU fallback");
    tryAppendXnnpack(sessionOptions);
  } else {
    ONNX_ALOG("[OnnxSession] XNNPACK disabled in config, skipping CPU fallback");
  }

  // Set threading options (applies to CPU fallback as well)
  sessionOptions.SetIntraOpNumThreads(config.intraOpThreads);
  sessionOptions.SetInterOpNumThreads(config.interOpThreads);

  ONNX_ALOG("[OnnxSession] Returning session options");
  return sessionOptions;
}

}  // namespace onnx_addon

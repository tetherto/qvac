#pragma once

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <string>

#include "AndroidLog.hpp"
#include "OnnxConfig.hpp"
#include "Logger.hpp"

#ifdef __ANDROID__
#include <nnapi_provider_factory.h>
#endif

#if defined(_WIN32) || defined(_WIN64)
#include <dml_provider_factory.h>
#endif

namespace onnx_addon {

// Try to append XNNPack execution provider if available and enabled.
// Downgrades optimization to BASIC to avoid com.ms.internal.nhwc schema
// issues (ORT bug: XNNPACK fused nodes reference NHWC schemas that are
// only registered at EXTENDED level, but EXTENDED's NhwcTransformer
// conflicts with XNNPACK fusion).
inline void tryAppendXnnpack(Ort::SessionOptions& sessionOptions) {
  try {
    const auto providers = Ort::GetAvailableProviders();
    const bool available =
        std::find(providers.begin(), providers.end(),
                  "XnnpackExecutionProvider") != providers.end();
    if (available) {
      sessionOptions.SetGraphOptimizationLevel(
          ::GraphOptimizationLevel::ORT_ENABLE_BASIC);
      sessionOptions.AppendExecutionProvider("XNNPACK", {});
      QLOG(logger::Priority::INFO, "[OnnxSession] XNNPack EP appended (optimization set to BASIC)");
      ONNX_ALOG("[OnnxSession] XNNPack EP appended (optimization set to BASIC)");
    } else {
      QLOG(logger::Priority::DEBUG, "[OnnxSession] XNNPack EP not available");
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

  QLOG(logger::Priority::DEBUG,
       std::string("[OnnxSession] buildSessionOptions - provider=") +
       providerToString(config.provider) + ", optimization=" +
       optimizationToString(config.optimization) + ", enableXnnpack=" +
       (config.enableXnnpack ? "true" : "false"));
  ONNX_ALOG("[OnnxSession] buildSessionOptions - provider=%s, optimization=%s, xnnpack=%s",
            providerToString(config.provider).c_str(),
            optimizationToString(config.optimization).c_str(),
            config.enableXnnpack ? "true" : "false");

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
    QLOG(logger::Priority::DEBUG, "[OnnxSession] CPU-only mode");
    if (config.enableXnnpack) {
      tryAppendXnnpack(sessionOptions);
    }
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
        // NNAPI does not register com.ms.internal.nhwc schemas, same
        // issue as XNNPACK, so we must drop to BASIC.
        //TODO: confirm with testing
        sessionOptions.SetGraphOptimizationLevel(
            ::GraphOptimizationLevel::ORT_ENABLE_BASIC);
        uint32_t nnapiFlags = NNAPI_FLAG_USE_FP16 | NNAPI_FLAG_CPU_DISABLED;
        Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_Nnapi(
            sessionOptions, nnapiFlags));
        QLOG(logger::Priority::INFO, "[OnnxSession] NNAPI EP appended (optimization set to BASIC)");
        ONNX_ALOG("[OnnxSession] NNAPI EP appended (optimization set to BASIC)");
      } else {
        QLOG(logger::Priority::WARNING, "[OnnxSession] NNAPI EP not available, falling back to CPU");
        ONNX_ALOG("[OnnxSession] NNAPI EP not available, falling back to CPU");
      }
    } catch (const std::exception& e) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Failed to append NNAPI: ") + e.what());
      ONNX_ALOG("[OnnxSession] Failed to append NNAPI: %s", e.what());
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
        QLOG(logger::Priority::INFO, "[OnnxSession] CoreML EP appended");
      } else {
        QLOG(logger::Priority::WARNING, "[OnnxSession] CoreML EP not available, falling back to CPU");
      }
    } catch (const std::exception& e) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Failed to append CoreML: ") + e.what());
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
        QLOG(logger::Priority::INFO, "[OnnxSession] DirectML EP appended");
      } else {
        QLOG(logger::Priority::WARNING, "[OnnxSession] DirectML EP not available, falling back to CPU");
      }
    } catch (const std::exception& e) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Failed to append DirectML: ") + e.what());
    }
  }
#endif

  // XNNPack as CPU fallback accelerator alongside GPU providers
  if (config.enableXnnpack) {
    tryAppendXnnpack(sessionOptions);
  }

  // Set threading options (applies to CPU fallback as well)
  sessionOptions.SetIntraOpNumThreads(config.intraOpThreads);
  sessionOptions.SetInterOpNumThreads(config.interOpThreads);

  return sessionOptions;
}

}  // namespace onnx_addon

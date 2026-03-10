#pragma once

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <string>

#include "OnnxConfig.hpp"
#include "Logger.hpp"

#ifdef __ANDROID__
#include <nnapi_provider_factory.h>
#endif

#if defined(_WIN32) || defined(_WIN64)
#include <dml_provider_factory.h>
#endif

namespace onnx_addon {

// Try to append XNNPack execution provider if available and enabled
inline void tryAppendXnnpack(Ort::SessionOptions& sessionOptions) {
  try {
    const auto providers = Ort::GetAvailableProviders();
    const bool available =
        std::find(providers.begin(), providers.end(),
                  "XnnpackExecutionProvider") != providers.end();
    if (available) {
      sessionOptions.AppendExecutionProvider("XNNPACK", {});
      QLOG(logger::Priority::INFO, "[OnnxSession] XNNPack execution provider appended");
    } else {
      QLOG(logger::Priority::DEBUG, "[OnnxSession] XNNPack execution provider not available");
    }
  } catch (const std::exception& e) {
    QLOG(logger::Priority::WARNING,
         std::string("[OnnxSession] Failed to append XNNPack: ") + e.what());
  }
}

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
    QLOG(logger::Priority::DEBUG, "[OnnxSession] Building session options with CPU provider");
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
        uint32_t nnapiFlags = NNAPI_FLAG_USE_FP16 | NNAPI_FLAG_CPU_DISABLED;
        Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_Nnapi(
            sessionOptions, nnapiFlags));
        QLOG(logger::Priority::INFO, "[OnnxSession] NNAPI execution provider appended");
      } else {
        QLOG(logger::Priority::WARNING, "[OnnxSession] NNAPI execution provider not available, falling back to CPU");
      }
    } catch (const std::exception& e) {
      QLOG(logger::Priority::WARNING,
           std::string("[OnnxSession] Failed to append NNAPI, falling back to CPU: ") + e.what());
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
    tryAppendXnnpack(sessionOptions);
  }

  // Set threading options (applies to CPU fallback as well)
  sessionOptions.SetIntraOpNumThreads(config.intraOpThreads);
  sessionOptions.SetInterOpNumThreads(config.interOpThreads);

  return sessionOptions;
}

}  // namespace onnx_addon

#include "Steps.hpp"

#include <algorithm>
#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

#include <onnxruntime/onnxruntime_session_options_config_keys.h>

#include "AndroidLog.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#if defined(_WIN32) || defined(_WIN64)
#include <dml_provider_factory.h>
#endif

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

std::string InferredText::toString() const {
  std::stringstream stringStream;
  stringStream << "Inferred text: '" << text << "', confidence: " << confidenceScore << ", bouding box: [";
  for (size_t i = 0; i < boxCoordinates.size(); ++i) {
    stringStream << "(" << boxCoordinates.at(i).x << ", " << boxCoordinates.at(i).y << ")";
    if (i != boxCoordinates.size() - 1) {
      stringStream << ", ";
    }
  }
  stringStream << "]";
  return stringStream.str();
};

Ort::SessionOptions getOrtSessionOptions(bool useGPU) {
  const std::string initMsg =
      "[ORT] getOrtSessionOptions called with useGPU=" + std::to_string(useGPU);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, initMsg);
  ALOG_DEBUG(initMsg);
  Ort::SessionOptions sessionOptions;
  sessionOptions.SetGraphOptimizationLevel(
      GraphOptimizationLevel::ORT_ENABLE_EXTENDED);

  const auto providers = Ort::GetAvailableProviders();
  // Log available execution providers for debugging
  std::stringstream providersMsg;
  providersMsg << "[ORT] Available execution providers: ";
  for (size_t i = 0; i < providers.size(); ++i) {
    providersMsg << providers[i];
    if (i < providers.size() - 1) {
      providersMsg << ", ";
    }
  }
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      providersMsg.str());
  ALOG_DEBUG(providersMsg.str());

  if (!useGPU) {
    bool useDefaultThreadSettings = true;
    std::string cpuMsg = "[ORT] CPU-only mode configured. ";

    try {
      const bool xnnpackAvailable =
          std::find(
              providers.begin(), providers.end(), "XnnpackExecutionProvider") !=
          providers.end();
      if (xnnpackAvailable) {
        // Order must be: spinning -> intra -> inter -> AppendEP.
        // Also see:
        // https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html
        int availableThreads =
            std::max(1, static_cast<int>(std::thread::hardware_concurrency()));

        sessionOptions.SetExecutionMode(ExecutionMode::ORT_PARALLEL);
        sessionOptions.AddConfigEntry(
            kOrtSessionOptionsConfigAllowIntraOpSpinning, "1");
        sessionOptions.AddConfigEntry(
            kOrtSessionOptionsConfigAllowInterOpSpinning, "1");
        sessionOptions.SetIntraOpNumThreads(availableThreads);
        sessionOptions.SetInterOpNumThreads(availableThreads);

#ifdef __ANDROID__
        // Cap threads on Android: avoid thermal throttling and big.LITTLE
        // contention.
        availableThreads = std::min(availableThreads, 4);
#endif
        sessionOptions.AppendExecutionProvider(
            "XNNPACK",
            {{"intra_op_num_threads", std::to_string(availableThreads)}});

        cpuMsg.append("XNNPack EP appended.");
        useDefaultThreadSettings = false;
      } else {
        cpuMsg.append("XNNPack EP not available.");
      }
    } catch (const std::exception& e) {
      cpuMsg.append("Failed to append XNNPack: " + std::string(e.what()));
    }

    if (useDefaultThreadSettings) {
      sessionOptions.SetIntraOpNumThreads(0); // 0 = use all available cores
      sessionOptions.SetInterOpNumThreads(0);
    }

    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, cpuMsg);
    ALOG_DEBUG(cpuMsg);

    return sessionOptions;
  }

#ifdef __ANDROID__
  try {
    const bool nnapiAvailable =
        std::find(
            providers.begin(), providers.end(), "NnapiExecutionProvider") !=
        providers.end();

    if (nnapiAvailable) {
      uint32_t nnapiFlags = NNAPI_FLAG_USE_FP16 | NNAPI_FLAG_CPU_DISABLED;
      Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_Nnapi(
          sessionOptions, nnapiFlags));
    }
  } catch (const std::exception& e) {
    const std::string errMsg =
        std::string("Error setting up NNAPI provider: ") + e.what();
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR, errMsg);
    ALOG_ERROR(errMsg);
  }

#elif defined(__APPLE__)
  try {
    const bool coremlAvailable =
        std::find(
            providers.begin(), providers.end(), "CoreMLExecutionProvider") !=
        providers.end();

    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         std::string("[ORT] CoreML available: ") + (coremlAvailable ? "yes" : "no"));
    if (coremlAvailable) {
      sessionOptions.AppendExecutionProvider("CoreML");
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[ORT] CoreML execution provider added");
    }
  } catch (const std::exception& e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         std::string("Error setting up CoreML provider: ") + e.what());
  }

#elif defined(_WIN32) || defined(_WIN64)

  try {
    const bool DmlExecutionProvider =
        std::find(providers.begin(), providers.end(), "DmlExecutionProvider") !=
        providers.end();
    if (DmlExecutionProvider) {
      sessionOptions.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
      sessionOptions.DisableMemPattern();
      Ort::ThrowOnError(
          OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0));
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, "Using DirectML execution provider");
    }
  } catch (const std::exception& e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         std::string("Error setting up DirectML provider: ") + e.what());
  }

#endif

  return sessionOptions;
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
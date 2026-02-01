#include "Steps.hpp"

#include <algorithm>
#include <cstdio>
#include <string>
#include <iostream>
#include <sstream>
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
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[ORT] getOrtSessionOptions called with useGPU=" + std::to_string(useGPU));
  Ort::SessionOptions sessionOptions;
  sessionOptions.SetGraphOptimizationLevel(
      GraphOptimizationLevel::ORT_ENABLE_EXTENDED);

  if (!useGPU) {
    // Enable multi-threading for CPU-only execution on desktop
    sessionOptions.SetIntraOpNumThreads(0);  // 0 = use all available cores
    sessionOptions.SetInterOpNumThreads(0);
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[ORT] CPU-only mode configured");
    return sessionOptions;
  }

  const auto providers = Ort::GetAvailableProviders();

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
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         std::string("Error setting up NNAPI provider: ") + e.what());
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
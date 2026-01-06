#include "Steps.hpp"

#include <algorithm>
#include <cstdio>
#include <iostream>
#include <sstream>

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
  std::printf("[ORT] getOrtSessionOptions called with useGPU=%s\n", useGPU ? "true" : "false");
  std::fflush(stdout);
  Ort::SessionOptions sessionOptions;
  sessionOptions.SetGraphOptimizationLevel(
      GraphOptimizationLevel::ORT_ENABLE_EXTENDED);

  if (!useGPU) {
    // Enable multi-threading for CPU-only execution on desktop
    sessionOptions.SetIntraOpNumThreads(0);  // 0 = use all available cores
    sessionOptions.SetInterOpNumThreads(0);
    std::printf("[ORT] CPU-only mode configured\n");
    std::fflush(stdout);
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
    std::printf("Error setting up NNAPI provider: %s\n", e.what());
  }

#elif defined(__APPLE__)
  try {
    const bool coremlAvailable =
        std::find(
            providers.begin(), providers.end(), "CoreMLExecutionProvider") !=
        providers.end();

    std::printf("[ORT] CoreML available: %s\n", coremlAvailable ? "yes" : "no");
    if (coremlAvailable) {
      sessionOptions.AppendExecutionProvider("CoreML");
      std::printf("[ORT] CoreML execution provider added\n");
    }
  } catch (const std::exception& e) {
    std::printf("Error setting up CoreML provider: %s\n", e.what());
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
      std::printf("Using DirectML execution provider\n");
    }
  } catch (const std::exception& e) {
    std::printf("Error setting up DirectML provider: %s\n", e.what());
  }

#endif

  return sessionOptions;
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
#include "Steps.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <opencv2/opencv.hpp>

#include "AndroidLog.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#if defined(_WIN32) || defined(_WIN64)
#include <dml_provider_factory.h>
#endif

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

std::string InferredText::toString() const {
  std::stringstream stringStream;
  stringStream << "Inferred text: '" << text << "', confidence: " << confidenceScore << ", bounding box: [";
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
    std::string cpuMsg = "[ORT] CPU-only mode configured. ";

    try {
      const bool xnnpackAvailable =
          std::find(
              providers.begin(), providers.end(), "XnnpackExecutionProvider") !=
          providers.end();

#if !(defined(_WIN32) || defined(_WIN64))
      if (xnnpackAvailable) {
        // Pass empty options so XNNPACK inherits ORT's thread pool rather than
        // creating its own pthreadpool.  Without this, XNNPACK's pool is not
        // tied to the session lifetime and can cause hangs on destruction.
        // See: https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html
        sessionOptions.AppendExecutionProvider("XNNPACK", {});
        cpuMsg.append("XNNPack EP appended.");
      } else {
        cpuMsg.append("XNNPack EP not available.");
      }
#else
      (void)xnnpackAvailable;
      // XNNPACK causes session-destruction crashes on Windows; use the CPU EP only.
      cpuMsg.append("XNNPack EP skipped on Windows; using CPU EP.");
#endif
    } catch (const std::exception& e) {
      cpuMsg.append("Failed to append XNNPack: " + std::string(e.what()));
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

Ort::Env& getSharedOrtEnv() {
  static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "OnnxOcr");
  return env;
}

#if defined(_WIN32) || defined(_WIN64)
namespace {
// Raw owning pointers that are intentionally never deleted.
// ~Ort::Session() on Windows corrupts global ORT state after the first call,
// causing SIGSEGV on all subsequent session destructions (ORT bug).
// By moving sessions here and never calling delete, we bypass the broken
// destructor.  The OS reclaims all memory when the process exits.
std::vector<Ort::Session*> windowsLeakedSessions; // NOLINT(cppcoreguidelines-avoid-non-const-global-variables)
} // namespace

void deferWindowsSessionLeak(Ort::Session session) {
  // Heap-allocate via move-construction so the OrtSession* handle transfers
  // to the new object.  The raw pointer is stored but never freed, preventing
  // ~Ort::Session() from running and avoiding the Windows crash.
  windowsLeakedSessions.push_back(new Ort::Session(std::move(session))); // NOLINT(cppcoreguidelines-owning-memory)
}
#endif

cv::Mat fourPointTransform(const cv::Mat &image, const std::array<cv::Point2f, 4> &rect) {
  cv::Point2f topLeft = rect[0];
  cv::Point2f topRight = rect[1];
  cv::Point2f bottomRight = rect[2];
  cv::Point2f bottomLeft = rect[3];

  const auto widthA = static_cast<float>(std::sqrt(std::pow(bottomRight.x - bottomLeft.x, 2) + std::pow(bottomRight.y - bottomLeft.y, 2)));
  const auto widthB = static_cast<float>(std::sqrt(std::pow(topRight.x - topLeft.x, 2) + std::pow(topRight.y - topLeft.y, 2)));
  const int maxWidth = std::max(static_cast<int>(widthA), static_cast<int>(widthB));

  const auto heightA = static_cast<float>(std::sqrt(std::pow(topRight.x - bottomRight.x, 2) + std::pow(topRight.y - bottomRight.y, 2)));
  const auto heightB = static_cast<float>(std::sqrt(std::pow(topLeft.x - bottomLeft.x, 2) + std::pow(topLeft.y - bottomLeft.y, 2)));
  const int maxHeight = std::max(static_cast<int>(heightA), static_cast<int>(heightB));

  if (maxWidth <= 0 || maxHeight <= 0) {
    return cv::Mat();
  }

  std::array<cv::Point2f, 4> destination = {
      {cv::Point2f(0.0F, 0.0F), cv::Point2f(static_cast<float>(maxWidth - 1), 0.0F), cv::Point2f(static_cast<float>(maxWidth - 1), static_cast<float>(maxHeight - 1)), cv::Point2f(0.0F, static_cast<float>(maxHeight - 1))}};

  cv::Mat perspectiveTransform = cv::getPerspectiveTransform(rect.data(), destination.data());
  cv::Mat warpedImg;
  cv::warpPerspective(image, warpedImg, perspectiveTransform, cv::Size(maxWidth, maxHeight));
  return warpedImg;
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
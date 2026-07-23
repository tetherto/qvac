#include "StepDoctrDetectionGGML.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>
#include <opencv2/opencv.hpp>

#include "model-interface/easyocr/pipeline/qlog.hpp"
#include "model-interface/easyocr/pipeline/steps.hpp"

// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access,readability-identifier-naming,readability-identifier-length,readability-implicit-bool-conversion,modernize-avoid-c-style-cast,cppcoreguidelines-pro-type-cstyle-cast)
// Detection post-processing iterates over cv::Mat planes with raw pointer
// arithmetic and uses standard math/DSP identifier conventions. The ggml
// C-API boundary (device/backend handles, proc-address function-pointer
// casts) and cv::Mat/cv::Scalar accessors only expose operator[], so the
// unchecked-access, implicit-bool, and C-style-cast checks are suppressed
// here to match the sibling easyocr inference steps.

namespace doctr::ggml::pipeline {

namespace {

// DocTR detection normalisation constants (from HuggingFace db_resnet50
// config).
// NOLINTBEGIN(bugprone-throwing-static-initialization)
const cv::Scalar DOCTR_DET_MEAN(0.798, 0.785, 0.772);
const cv::Scalar DOCTR_DET_STD(0.264, 0.2749, 0.287);
// NOLINTEND(bugprone-throwing-static-initialization)
constexpr double PIXEL_MAX = 255.0;

constexpr int kNumChannels = 3;

// Mean probability inside a bounding rectangle (assume_straight_pages=True).
float boxScore(const cv::Mat& probMap, const cv::Rect& bbox) {
  const int x0 = std::max(0, bbox.x);
  const int y0 = std::max(0, bbox.y);
  const int x1 = std::min(probMap.cols - 1, bbox.x + bbox.width);
  const int y1 = std::min(probMap.rows - 1, bbox.y + bbox.height);
  if (x1 <= x0 || y1 <= y0) {
    return 0.0F;
  }
  const cv::Mat roi = probMap(cv::Rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1));
  return static_cast<float>(cv::mean(roi)[0]);
}

[[noreturn]] void raise(const std::string& msg) {
  throw std::runtime_error("[DoctrDetectionGGML] " + msg);
}

} // namespace

StepDoctrDetectionGGML::StepDoctrDetectionGGML(
    const std::string& pathDetector, int nThreads,
    ggml_backend_dev_t backendDevice) {
  ggml_backend_dev_t dev =
      (backendDevice != nullptr)
          ? backendDevice
          : ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  ggml_backend_t backend = dev ? ggml_backend_dev_init(dev, nullptr) : nullptr;
  if (backend == nullptr) {
    raise("failed to initialise ggml backend");
  }
  // Thread-count tuning only applies to the CPU backend; GPU backends (Vulkan)
  // ignore it, so gate the call on the selected device being CPU.
  const bool isCpu = ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_CPU;
  if (isCpu && nThreads >= 0) {
    const int effective =
        (nThreads > 0) ? nThreads
                       : static_cast<int>(std::thread::hardware_concurrency());
    ggml_backend_reg_t cpuReg = ggml_backend_dev_backend_reg(dev);
    auto* fn_set_n_threads =
        cpuReg
            ? (ggml_backend_set_n_threads_t)ggml_backend_reg_get_proc_address(
                  cpuReg, "ggml_backend_set_n_threads")
            : nullptr;
    if (fn_set_n_threads) {
      fn_set_n_threads(backend, effective);
    }
  }
  backends_.push_back(backend);

  std::vector<std::string> labels;
  weights_ = qvac_lib_infer_ggml_classification::graph::loadWeights(
      pathDetector, backends_, labels);
  // The compute graph is built lazily per input canvas size (see ensureGraph),
  // since the canvas is the image's aspect ratio padded to a multiple of 32 —
  // not a fixed square — so detection only convolves real content.

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[DoctrDetectionGGML] GGML detection model loaded");
}

void StepDoctrDetectionGGML::ensureGraph(int inputW, int inputH) {
  if (computeGraph_.input != nullptr && computeGraph_.input->ne[0] == inputW &&
      computeGraph_.input->ne[1] == inputH) {
    return; // graph already matches this canvas size
  }
  computeGraph_ = qvac_lib_infer_ggml_classification::graph::buildGraph(
      weights_, backends_, inputW, inputH);
}

StepDoctrDetectionGGML::~StepDoctrDetectionGGML() {
  computeGraph_.reset();
  weights_.reset();
  for (ggml_backend_t b : backends_) {
    if (b != nullptr) {
      ggml_backend_free(b);
    }
  }
  backends_.clear();
}

std::tuple<cv::Mat, float, int, int, int, int>
StepDoctrDetectionGGML::preprocessImage(const cv::Mat& img) {
  const int h = img.rows;
  const int w = img.cols;
  const float scale = std::min(
      static_cast<float>(DBNET_INPUT_SIZE) / static_cast<float>(h),
      static_cast<float>(DBNET_INPUT_SIZE) / static_cast<float>(w));
  const int newH = static_cast<int>(static_cast<float>(h) * scale);
  const int newW = static_cast<int>(static_cast<float>(w) * scale);

  cv::Mat resized;
  cv::resize(img, resized, cv::Size(newW, newH), 0, 0, cv::INTER_LINEAR);

  cv::Mat floatImg;
  resized.convertTo(floatImg, CV_32FC3, 1.0 / PIXEL_MAX);

  // Canvas = a fixed DBNET_INPUT_SIZE square with the resized image centred by
  // symmetric padding, mirroring python-doctr's PreProcessor (preserve aspect
  // ratio + symmetric pad to the model's 1024x1024 training size). An
  // aspect-ratio canvas (padding only the short side to a stride multiple)
  // changes db_mobilenet's SE-block global-average-pool statistics, shifting
  // the probability map and over-producing boxes on scene text — so match
  // doctr's square canvas exactly for detection parity.
  const int canvasW = DBNET_INPUT_SIZE;
  const int canvasH = DBNET_INPUT_SIZE;
  const int padLeft = (canvasW - newW) / 2;
  const int padTop = (canvasH - newH) / 2;

  cv::Mat padded = cv::Mat::zeros(canvasH, canvasW, CV_32FC3);
  floatImg.copyTo(padded(cv::Rect(padLeft, padTop, newW, newH)));

  cv::subtract(padded, DOCTR_DET_MEAN, padded);
  cv::divide(padded, DOCTR_DET_STD, padded);

  return {padded, scale, newW, newH, padLeft, padTop};
}

cv::Mat StepDoctrDetectionGGML::runInference(const cv::Mat& preprocessed) {
  const int H = preprocessed.rows;
  const int W = preprocessed.cols;
  CV_Assert(W % 32 == 0 && H % 32 == 0);
  CV_Assert(W <= DBNET_INPUT_SIZE && H <= DBNET_INPUT_SIZE);
  CV_Assert(preprocessed.type() == CV_32FC3);
  CV_Assert(preprocessed.isContinuous());

  // Build (or reuse) the graph for this canvas size.
  ensureGraph(W, H);

  // Deinterleave HWC -> CHW directly into the reusable inputBuffer_.
  // Previously this path used `cv::split` + a per-channel `memcpy`, which
  // allocated three full-resolution scratch `cv::Mat`s on every call
  // (~12 MB at DBNET_INPUT_SIZE=1024).  The single-pass HWC->CHW loop
  // below produces identical bytes but reuses `inputBuffer_` across calls.
  const size_t planeFloats = static_cast<size_t>(H) * W;
  inputBuffer_.resize(planeFloats * static_cast<size_t>(kNumChannels));

  const auto* srcHwc = preprocessed.ptr<float>();
  float* dstChwR = inputBuffer_.data();
  float* dstChwG = dstChwR + planeFloats;
  float* dstChwB = dstChwG + planeFloats;
  for (size_t i = 0; i < planeFloats; ++i) {
    const size_t si = i * kNumChannels;
    dstChwR[i] = srcHwc[si];
    dstChwG[i] = srcHwc[si + 1];
    dstChwB[i] = srcHwc[si + 2];
  }

  ggml_backend_tensor_set(
      computeGraph_.input,
      inputBuffer_.data(),
      0,
      inputBuffer_.size() * sizeof(float));

  const ggml_status status =
      ggml_backend_graph_compute(backends_[0], computeGraph_.graph);
  if (status != GGML_STATUS_SUCCESS) {
    raise(
        "ggml_backend_graph_compute failed with status " +
        std::to_string(static_cast<int>(status)));
  }

  // The graph applies sigmoid on-device, so output_4 is already the probability
  // map; read it back directly.
  const auto nElems =
      static_cast<size_t>(ggml_nelements(computeGraph_.output_4));
  logitBuffer_.resize(nElems);
  ggml_backend_tensor_get(
      computeGraph_.output_4, logitBuffer_.data(), 0, nElems * sizeof(float));

  // GGML WHCN [W=1024, H=1024, C=1, N=1] lays out as [W*y + x] in memory
  // which matches OpenCV row-major [H, W] — direct wrap is safe.
  cv::Mat probMap(H, W, CV_32F, logitBuffer_.data());
  // Clone before logitBuffer_ may be resized by the next call.
  return probMap.clone();
}

std::pair<std::vector<std::array<cv::Point2f, 4>>, std::vector<float>>
StepDoctrDetectionGGML::extractPolygons(
    const cv::Mat& probMap, float scale, int /*paddedW*/, int /*paddedH*/,
    int padLeft, int padTop, int origW, int origH) {
  cv::Mat binary;
  cv::threshold(
      probMap,
      binary,
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
      BINARIZE_THRESHOLD - 1e-6F,
      1.0,
      cv::THRESH_BINARY);
  binary.convertTo(binary, CV_8U);

  const cv::Mat kernel =
      cv::getStructuringElement(cv::MORPH_RECT, cv::Size(3, 3));
  cv::morphologyEx(binary, binary, cv::MORPH_OPEN, kernel);

  std::vector<std::vector<cv::Point>> contours;
  cv::findContours(
      binary, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

  std::vector<std::array<cv::Point2f, 4>> polygons;
  std::vector<float> confidences;

  for (const auto& contour : contours) {
    const cv::Rect bbox = cv::boundingRect(contour);
    if (bbox.width < MIN_SIZE_BOX || bbox.height < MIN_SIZE_BOX) {
      continue;
    }

    const float score = boxScore(probMap, bbox);
    if (score < BOX_THRESHOLD) {
      continue;
    }

    // Unclip: expand bounding rect by distance = area * ratio / perimeter.
    const double area = static_cast<double>(bbox.width) * bbox.height;
    const double perim = 2.0 * (bbox.width + bbox.height);
    const double dist = area * UNCLIP_RATIO / perim;

    const float ex0 = static_cast<float>(bbox.x) - static_cast<float>(dist);
    const float ey0 = static_cast<float>(bbox.y) - static_cast<float>(dist);
    const float ex1 =
        static_cast<float>(bbox.x + bbox.width) + static_cast<float>(dist);
    const float ey1 =
        static_cast<float>(bbox.y + bbox.height) + static_cast<float>(dist);

    // Map canvas pixel coords back to the original image: undo the symmetric
    // pad offset, then the resize scale. This is the exact inverse of
    // preprocessImage and works for any (aspect-ratio or square) padding —
    // unlike the prior square-only normalized form.
    const auto toOrigX = [&](float px) {
      return std::clamp(
          (px - static_cast<float>(padLeft)) / scale,
          0.0F,
          static_cast<float>(origW));
    };
    const auto toOrigY = [&](float py) {
      return std::clamp(
          (py - static_cast<float>(padTop)) / scale,
          0.0F,
          static_cast<float>(origH));
    };
    const float x0 = toOrigX(ex0);
    const float y0 = toOrigY(ey0);
    const float x1 = toOrigX(ex1);
    const float y1 = toOrigY(ey1);

    if ((x1 - x0) < 1.0F || (y1 - y0) < 1.0F) {
      continue;
    }

    polygons.push_back(
        {{cv::Point2f(x0, y0),
          cv::Point2f(x1, y0),
          cv::Point2f(x1, y1),
          cv::Point2f(x0, y1)}});
    confidences.push_back(score);
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[DoctrDetectionGGML] extracted " + std::to_string(polygons.size()) +
          " polygons");
  return {polygons, confidences};
}

StepDoctrDetectionGGML::Output
StepDoctrDetectionGGML::process(const Input& input) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[DoctrDetectionGGML] processing " + std::to_string(input.origImg.cols) +
          "x" + std::to_string(input.origImg.rows));

  auto [preprocessed, scale, paddedW, paddedH, padLeft, padTop] =
      preprocessImage(input.origImg);

  cv::Mat probMap = runInference(preprocessed);

  auto [polygons, confidences] = extractPolygons(
      probMap,
      scale,
      paddedW,
      paddedH,
      padLeft,
      padTop,
      input.origImg.cols,
      input.origImg.rows);

  Output output;
  output.context = input;
  output.polygons = std::move(polygons);
  output.polygonConfidences = std::move(confidences);
  output.probMap = probMap;
  output.paddedW = paddedW;
  output.paddedH = paddedH;
  output.padLeft = padLeft;
  output.padTop = padTop;
  return output;
}

} // namespace doctr::ggml::pipeline

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access,readability-identifier-naming,readability-identifier-length,readability-implicit-bool-conversion,modernize-avoid-c-style-cast,cppcoreguidelines-pro-type-cstyle-cast)

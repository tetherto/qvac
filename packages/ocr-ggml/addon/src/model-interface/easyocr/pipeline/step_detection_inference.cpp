// Adapted from @qvac/ocr-onnx's addon/pipeline/StepDetectionInference.cpp.
//
// Verbatim from source:
//   - constants (MAX_IMAGE_SIZE, RATIO_DETECTOR_NET, SIZE_MULTIPLE,
//     DEFAULT_MEAN, DEFAULT_VARIANCE, PIXEL_INTENSITY_MAX);
//   - resizeAspectRatio() — aspect-preserving resize + pad to multiple of 32;
//   - normalizeAndBuildCHW() — single-pass uint8 HWC -> float32 NCHW with
//     ImageNet mean/variance normalization.
//
// Replaced:
//   - ONNX Runtime session + extractOutputFromOrtValue() with the GGML
//     `build_craft` pipeline (init backend, allocate gallocr, run graph,
//     copy NHWC output back into two cv::Mat planes).

#include "step_detection_inference.hpp"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <opencv2/opencv.hpp>

#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"
#include "model-interface/easyocr/craft.hpp"
#include "model-interface/easyocr/craft_weights.hpp"
#include "model-interface/easyocr/gguf_loader.hpp"

// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
// DSP / inference inner loops use raw pointer arithmetic on cv::Mat planes
// and ggml buffers, single-letter math identifiers, and CRAFT/DBNet
// architecture-defined magic numbers.
#include "qlog.hpp"

namespace easyocr::ggml::pipeline {

namespace {

// canvas_size in python
constexpr int MAX_IMAGE_SIZE = 2560;

// ratio_net in python — controls the detector's spatial downsampling
constexpr float RATIO_DETECTOR_NET = 2.0F;

constexpr int SIZE_MULTIPLE = 32;
// NOLINTBEGIN(bugprone-throwing-static-initialization)
const cv::Scalar DEFAULT_MEAN(0.485, 0.456, 0.406);
const cv::Scalar DEFAULT_VARIANCE(0.229, 0.224, 0.225);
// NOLINTEND(bugprone-throwing-static-initialization)
constexpr double PIXEL_INTENSITY_MAX = 255.0;

/**
 * @brief Resizes an image while preserving its aspect ratio and pads it to
 * a size that's a multiple of 32. Returns the resized image in its original
 * depth (typically CV_8U) — float conversion is deferred to the CHW pass.
 *
 * Verbatim from ocr-onnx StepDetectionInference.cpp.
 */
std::tuple<cv::Mat, float>
resizeAspectRatio(const cv::Mat& img, float magRatio) {
  int height = img.rows;
  int width = img.cols;

  float targetSize = magRatio * static_cast<float>(std::max(height, width));

  targetSize = std::min(targetSize, static_cast<float>(MAX_IMAGE_SIZE));

  float inputResizeRatio =
      targetSize / static_cast<float>(std::max(height, width));
  int targetH = static_cast<int>(static_cast<float>(height) * inputResizeRatio);
  int targetW = static_cast<int>(static_cast<float>(width) * inputResizeRatio);

  cv::Mat proc;
  cv::resize(img, proc, cv::Size(targetW, targetH), 0, 0, cv::INTER_LINEAR);

  int targetH32 = targetH;
  int targetW32 = targetW;
  if (targetH % SIZE_MULTIPLE != 0) {
    targetH32 = targetH + (SIZE_MULTIPLE - (targetH % SIZE_MULTIPLE));
  }
  if (targetW % SIZE_MULTIPLE != 0) {
    targetW32 = targetW + (SIZE_MULTIPLE - (targetW % SIZE_MULTIPLE));
  }

  cv::Mat resized;
  cv::copyMakeBorder(
      proc,
      resized,
      0,
      targetH32 - targetH,
      0,
      targetW32 - targetW,
      cv::BORDER_CONSTANT,
      cv::Scalar::all(0));

  return {resized, inputResizeRatio};
}

/**
 * @brief Single-pass: uint8 HWC padded image -> float32 NCHW blob with
 *        mean/variance normalization baked in.  Verbatim from ocr-onnx.
 */
cv::Mat normalizeAndBuildCHW(const cv::Mat& img) {
  const int height = img.rows;
  const int width = img.cols;
  const int numChannels = img.channels();
  CV_Assert(numChannels == 3);
  const size_t totalPixels = static_cast<size_t>(height) * width;

  // Pre-compute normalization constants:
  //   result = (pixel - mean*255) * (1 / (var*255))
  const std::array<float, 3> meanVals = {
      static_cast<float>(DEFAULT_MEAN[0] * PIXEL_INTENSITY_MAX),
      static_cast<float>(DEFAULT_MEAN[1] * PIXEL_INTENSITY_MAX),
      static_cast<float>(DEFAULT_MEAN[2] * PIXEL_INTENSITY_MAX)};
  const std::array<float, 3> invVarVals = {
      static_cast<float>(1.0 / (DEFAULT_VARIANCE[0] * PIXEL_INTENSITY_MAX)),
      static_cast<float>(1.0 / (DEFAULT_VARIANCE[1] * PIXEL_INTENSITY_MAX)),
      static_cast<float>(1.0 / (DEFAULT_VARIANCE[2] * PIXEL_INTENSITY_MAX))};

  cv::Mat chwBlob(numChannels, static_cast<int>(totalPixels), CV_32F);
  const std::array<float*, 3> planes = {
      chwBlob.ptr<float>(0), chwBlob.ptr<float>(1), chwBlob.ptr<float>(2)};

  if (img.depth() == CV_8U) {
    const auto* src = img.ptr<uint8_t>();
    for (size_t i = 0; i < totalPixels; ++i) {
      const size_t si = i * 3;
      planes[0][i] =
          (static_cast<float>(src[si]) - meanVals[0]) * invVarVals[0];
      planes[1][i] =
          (static_cast<float>(src[si + 1]) - meanVals[1]) * invVarVals[1];
      planes[2][i] =
          (static_cast<float>(src[si + 2]) - meanVals[2]) * invVarVals[2];
    }
  } else {
    const auto* src = img.ptr<float>();
    for (size_t i = 0; i < totalPixels; ++i) {
      const size_t si = i * 3;
      planes[0][i] = (src[si] - meanVals[0]) * invVarVals[0];
      planes[1][i] = (src[si + 1] - meanVals[1]) * invVarVals[1];
      planes[2][i] = (src[si + 2] - meanVals[2]) * invVarVals[2];
    }
  }

  return chwBlob.reshape(1, {1, numChannels, height, width});
}

} // namespace

cv::Mat StepDetectionInference::preprocess(
    const cv::Mat& image, float magRatio, float* outResizeRatio) {
  auto [imgResized, imgResizeRatio] = resizeAspectRatio(image, magRatio);
  if (outResizeRatio != nullptr) {
    *outResizeRatio = imgResizeRatio;
  }
  return normalizeAndBuildCHW(imgResized);
}

// TODO(clang-tidy): the (magRatio, nThreads) pair is convertible (float vs
// int); make the constructor accept named parameters or distinct strong
// types to prevent accidental swap.
StepDetectionInference::StepDetectionInference(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    const std::string& gguf_path, float magRatio, int nThreads)
    : magRatio_(magRatio),
      backend_(
          (ggml_backend_load_all(),
           ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr))) {
  if (backend_ == nullptr) {
    throw std::runtime_error(
        "StepDetectionInference: ggml_backend_init_by_type(CPU) failed");
  }
  if (nThreads >= 0) {
    const int effective =
        (nThreads == 0) ? defaultPhysicalThreadCount() : nThreads;
    ggml_backend_cpu_set_n_threads(backend_, effective);
  }

  loader_ = std::make_unique<easyocr::ggml::GgufLoader>(
      gguf_path, /*load_tensor_data=*/true);
  if (!loader_->ok()) {
    throw std::runtime_error(
        "StepDetectionInference: failed to open GGUF: " + gguf_path);
  }

  weights_ = std::make_unique<easyocr::ggml::CraftWeights>(*loader_, backend_);
  if (!weights_->ok()) {
    throw std::runtime_error(
        "StepDetectionInference: CraftWeights load failed: " + weights_->err());
  }
}

StepDetectionInference::~StepDetectionInference() {
  weights_.reset();
  loader_.reset();
  if (backend_ != nullptr) {
    ggml_backend_free(backend_);
    backend_ = nullptr;
  }
}

std::pair<cv::Mat, cv::Mat>
StepDetectionInference::runInference(const cv::Mat& inputBlob) {
  using clock = std::chrono::high_resolution_clock;
  using msd = std::chrono::duration<double, std::milli>;

  // inputBlob is CV_32F NCHW with shape [1, 3, H, W] (rows = 1 batch,
  // dims = 4).  cv::Mat stores the underlying floats row-major in the
  // same NCHW order PyTorch and ggml share, so we can hand the bytes
  // directly to ggml_backend_tensor_set.
  assert(inputBlob.dims == 4);
  const int N = inputBlob.size[0];
  const int C = inputBlob.size[1];
  const int H = inputBlob.size[2];
  const int W = inputBlob.size[3];
  if (N != 1 || C != 3) {
    throw std::runtime_error(
        "StepDetectionInference::runInference: expected NCHW [1,3,H,W]");
  }

  // ---- Stage: graph build ----
  const auto tBuild0 = clock::now();
  const size_t graph_ctx_size =
      (ggml_tensor_overhead() * GGML_DEFAULT_GRAPH_SIZE) +
      ggml_graph_overhead();
  std::vector<uint8_t> graph_buf(graph_ctx_size);
  ggml_init_params init{
      .mem_size = graph_ctx_size,
      .mem_buffer = graph_buf.data(),
      .no_alloc = true,
  };
  ggml_context* gctx = ggml_init(init);

  auto* x = ggml_new_tensor_4d(gctx, GGML_TYPE_F32, W, H, C, N);
  ggml_set_name(x, "input");

  auto* out = easyocr::ggml::build_craft(gctx, *weights_, x, /*taps=*/nullptr);
  ggml_set_output(out);

  auto* gf = ggml_new_graph_custom(gctx, GGML_DEFAULT_GRAPH_SIZE, false);
  ggml_build_forward_expand(gf, out);
  const auto tBuild1 = clock::now();
  lastTimings_.graphBuildMs = msd(tBuild1 - tBuild0).count();

  // ---- Stage: graph alloc ----
  const auto tAlloc0 = clock::now();
  auto* gallocr =
      ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend_));
  if (!ggml_gallocr_alloc_graph(gallocr, gf)) {
    ggml_gallocr_free(gallocr);
    ggml_free(gctx);
    throw std::runtime_error(
        "StepDetectionInference: ggml_gallocr_alloc_graph failed");
  }
  ggml_backend_tensor_set(x, inputBlob.ptr<float>(), 0, ggml_nbytes(x));
  const auto tAlloc1 = clock::now();
  lastTimings_.graphAllocMs = msd(tAlloc1 - tAlloc0).count();

  // ---- Stage: graph compute (actual inference) ----
  const auto tCompute0 = clock::now();
  if (ggml_backend_graph_compute(backend_, gf) != GGML_STATUS_SUCCESS) {
    ggml_gallocr_free(gallocr);
    ggml_free(gctx);
    throw std::runtime_error(
        "StepDetectionInference: ggml_backend_graph_compute failed");
  }
  const auto tCompute1 = clock::now();
  lastTimings_.graphComputeMs = msd(tCompute1 - tCompute0).count();

  // ---- Stage 4a: tensor_get (device -> host copy) ----
  const auto tGet0 = clock::now();
  // out has ggml ne [2, W/2, H/2, 1] == NHWC [1, H/2, W/2, 2]. Copy it
  // back as [H/2, W/2, 2] interleaved, then split into two single-channel
  // CV_32F mats — same memory layout `extractOutputFromOrtValue` produced.
  const int outH = static_cast<int>(out->ne[2]);
  const int outW = static_cast<int>(out->ne[1]);
  assert(out->ne[0] == 2 && out->ne[3] == 1);

  std::vector<float> nhwc(static_cast<size_t>(outH) * outW * 2);
  ggml_backend_tensor_get(out, nhwc.data(), 0, ggml_nbytes(out));
  const auto tGet1 = clock::now();
  lastTimings_.tensorGetMs = msd(tGet1 - tGet0).count();

  // ---- Stage 4b: NHWC -> (textMap, linkMap) scalar deinterleave ----
  const auto tDeinterleave0 = clock::now();
  cv::Mat textMap(outH, outW, CV_32F);
  cv::Mat linkMap(outH, outW, CV_32F);
  const float* p = nhwc.data();
  for (int y = 0; y < outH; ++y) {
    auto* tRow = textMap.ptr<float>(y);
    auto* lRow = linkMap.ptr<float>(y);
    for (int xCol = 0; xCol < outW; ++xCol) {
      tRow[xCol] = p[(((y * outW) + xCol) * 2) + 0];
      lRow[xCol] = p[(((y * outW) + xCol) * 2) + 1];
    }
  }
  const auto tDeinterleave1 = clock::now();
  lastTimings_.deinterleaveMs = msd(tDeinterleave1 - tDeinterleave0).count();

  ggml_gallocr_free(gallocr);
  ggml_free(gctx);

  return {textMap, linkMap};
}

std::vector<BlockTiming> StepDetectionInference::profileBlocks(
    const StepDetectionInference::Input& input,
    const std::vector<std::string>& tapNames, int warmupPerTap,
    int runsPerTap) {
  using clock = std::chrono::high_resolution_clock;
  using msd = std::chrono::duration<double, std::milli>;

  runsPerTap = std::max(runsPerTap, 1);
  warmupPerTap = std::max(warmupPerTap, 0);

  auto [imgResized, _imgResizeRatio] =
      resizeAspectRatio(input.origImg, magRatio_);
  cv::Mat inputBlob = normalizeAndBuildCHW(imgResized);
  assert(inputBlob.dims == 4);
  const int N = inputBlob.size[0];
  const int C = inputBlob.size[1];
  const int H = inputBlob.size[2];
  const int W = inputBlob.size[3];

  std::vector<BlockTiming> out;
  out.reserve(tapNames.size());

  for (const auto& tapName : tapNames) {
    // Each tap gets its own fresh ggml_context + gallocr because the
    // sub-cgraph that ends at `tapName` may need different allocator
    // planning than other taps.  We then call ggml_backend_graph_compute
    // on it (warmupPerTap + runsPerTap) times, which is valid for any
    // ggml backend: the input tensor data persists, intermediate
    // tensors are simply recomputed in place each call.
    const size_t graph_ctx_size =
        (ggml_tensor_overhead() * GGML_DEFAULT_GRAPH_SIZE) +
        ggml_graph_overhead();
    std::vector<uint8_t> graph_buf(graph_ctx_size);
    ggml_init_params init{
        .mem_size = graph_ctx_size,
        .mem_buffer = graph_buf.data(),
        .no_alloc = true,
    };
    ggml_context* gctx = ggml_init(init);

    auto* x = ggml_new_tensor_4d(gctx, GGML_TYPE_F32, W, H, C, N);
    ggml_set_name(x, "input");

    std::unordered_map<std::string, ggml_tensor*> taps;
    (void)easyocr::ggml::build_craft(gctx, *weights_, x, &taps);

    auto it = taps.find(tapName);
    if (it == taps.end() || it->second == nullptr) {
      ggml_free(gctx);
      throw std::runtime_error(
          "profileBlocks: unknown or unpopulated tap '" + tapName + "'");
    }
    ggml_tensor* tapTensor = it->second;
    ggml_set_output(tapTensor);

    auto* gf = ggml_new_graph_custom(gctx, GGML_DEFAULT_GRAPH_SIZE, false);
    ggml_build_forward_expand(gf, tapTensor);

    auto* gallocr =
        ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend_));
    if (!ggml_gallocr_alloc_graph(gallocr, gf)) {
      ggml_gallocr_free(gallocr);
      ggml_free(gctx);
      throw std::runtime_error(
          "profileBlocks: gallocr_alloc_graph failed for tap " + tapName);
    }
    ggml_backend_tensor_set(x, inputBlob.ptr<float>(), 0, ggml_nbytes(x));

    // ---- Warmup passes (untimed) ----
    for (int w = 0; w < warmupPerTap; ++w) {
      if (ggml_backend_graph_compute(backend_, gf) != GGML_STATUS_SUCCESS) {
        ggml_gallocr_free(gallocr);
        ggml_free(gctx);
        throw std::runtime_error(
            "profileBlocks: warmup graph_compute failed for tap " + tapName);
      }
    }

    // ---- Measured passes ----
    std::vector<double> samples;
    samples.reserve(static_cast<size_t>(runsPerTap));
    for (int r = 0; r < runsPerTap; ++r) {
      const auto t0 = clock::now();
      if (ggml_backend_graph_compute(backend_, gf) != GGML_STATUS_SUCCESS) {
        ggml_gallocr_free(gallocr);
        ggml_free(gctx);
        throw std::runtime_error(
            "profileBlocks: measured graph_compute failed for tap " + tapName);
      }
      const auto t1 = clock::now();
      samples.push_back(msd(t1 - t0).count());
    }

    // Report min as the canonical cumulative cost (see header for why).
    double minSample = samples.empty() ? 0.0 : samples.front();
    for (double s : samples) {
      minSample = std::min(s, minSample);
    }

    out.push_back(
        {.tapName = tapName,
         .cumulativeMs = minSample,
         .samplesMs = std::move(samples)});

    ggml_gallocr_free(gallocr);
    ggml_free(gctx);
  }

  return out;
}

StepDetectionInference::Output
StepDetectionInference::process(const StepDetectionInference::Input& input) {
  using clock = std::chrono::high_resolution_clock;
  using msd = std::chrono::duration<double, std::milli>;

  lastTimings_ = DetectionStageTimings{};

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      std::string("[DetectionInference] Starting - origImg size=") +
          std::to_string(input.origImg.cols) + "x" +
          std::to_string(input.origImg.rows) +
          ", channels=" + std::to_string(input.origImg.channels()) +
          ", magRatio=" + std::to_string(magRatio_));

  const auto tPre0 = clock::now();
  auto [imgResized, imgResizeRatio] =
      resizeAspectRatio(input.origImg, magRatio_);
  cv::Mat inputBlob = normalizeAndBuildCHW(imgResized);
  const auto tPre1 = clock::now();
  lastTimings_.preprocessMs = msd(tPre1 - tPre0).count();

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      std::string("[DetectionInference] After resize - size=") +
          std::to_string(imgResized.cols) + "x" +
          std::to_string(imgResized.rows) +
          ", ratio=" + std::to_string(imgResizeRatio));

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[DetectionInference] Running GGML inference...");
  ALOG_DEBUG(std::string("[DetectionInference] Running GGML inference..."));
  auto [scoreText, scoreLink] = runInference(inputBlob);

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      std::string("[DetectionInference] Output extracted - scoreText=") +
          std::to_string(scoreText.cols) + "x" +
          std::to_string(scoreText.rows) +
          ", scoreLink=" + std::to_string(scoreLink.cols) + "x" +
          std::to_string(scoreLink.rows));

  return {
      .context = input,
      .textMap = scoreText,
      .linkMap = scoreLink,
      .imgResizeRatio = RATIO_DETECTOR_NET / imgResizeRatio};
}

} // namespace easyocr::ggml::pipeline

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)

#include "Pipeline.hpp"

#include <chrono>
#include <filesystem>
#include <mutex>
#include <stdexcept>
#include <utility>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"

#include "easyocr/pipeline/qlog.hpp"

#ifdef __ANDROID__
#include <android/log.h>
#include <dlfcn.h>
#include <link.h>
#endif

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
// Pipeline consolidates the EasyOCR and DocTR orchestrators into a single
// IModel adapter, mirroring `@qvac/ocr-onnx`'s `Pipeline` class. The
// mode-specific step sequences live in private `processEasyOcr` /
// `processDoctr` helpers; everything else (image decode, timing, cancel,
// runtimeStats) is shared.

namespace {

// Route ggml log lines to logcat on Android. Mirrors the nmtGgmlLogCallback
// in translation-nmtcpp's NmtLazyInitializeBackend.cpp.
void ocrGgmlLogCallback(
    enum ggml_log_level level, const char* text, void* /*user_data*/) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  if (text == nullptr || text[0] == '\0') { // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return;
  }
  if (level == GGML_LOG_LEVEL_DEBUG) {
    return;
  }

  Priority priority = Priority::INFO;
  switch (level) {
  case GGML_LOG_LEVEL_ERROR:
    priority = Priority::ERROR_;
    break;
  case GGML_LOG_LEVEL_WARN:
    priority = Priority::WARN;
    break;
  default:
    break;
  }

  size_t len = std::strlen(text);
  // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  while (len > 0 && (text[len - 1] == '\n' || text[len - 1] == '\r')) {
    --len;
  }
  // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  if (len == 0) {
    return;
  }

#ifdef __ANDROID__
  if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) {
    __android_log_print(
        level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN,
        "ggml-ocr", "%.*s", static_cast<int>(len), text);
  }
#endif

  std::string message;
  message.reserve(7 + len); // NOLINT(cppcoreguidelines-avoid-magic-numbers)
  message.append("[ggml] ");
  message.append(text, len);
  QLOG(priority, message);
}

// Route GGML_ABORT messages to logcat synchronously before abort() fires.
// Without this, assertion failures inside backend .so code are silent on
// Android because stderr is dropped. See NmtLazyInitializeBackend.cpp.
void ocrGgmlAbortCallback(const char* message) {
  if (message == nullptr) {
    message = "(null abort message)";
  }
#ifdef __ANDROID__
  __android_log_print(
      ANDROID_LOG_FATAL, "ggml-ocr-abort", "GGML_ABORT: %s", message);
#endif
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::ERROR_,
      std::string("[ggml-abort] ") + message);
}

#ifdef __ANDROID__
// Install log + abort callbacks into each already-loaded ggml backend .so.
// Each backend is loaded with RTLD_LOCAL, so its copy of g_logger_state and
// g_abort_callback is private. We must patch each one separately after
// ggml_backend_load_all_from_path returns. Mirrors nmtInstallCallbacksInLoadedBackendSos.
static int ocrBackendSoIterCallback(
    struct dl_phdr_info* info, size_t /*size*/, void* data) {
  if (info == nullptr || info->dlpi_name == nullptr ||
      info->dlpi_name[0] == '\0') {
    return 0;
  }
  const char* slash = strrchr(info->dlpi_name, '/');
  const char* filename = slash ? slash + 1 : info->dlpi_name;
  if (strstr(filename, "ggml") == nullptr || strstr(filename, ".so") == nullptr) {
    return 0;
  }
  static_cast<std::vector<std::string>*>(data)->emplace_back(info->dlpi_name);
  return 0;
}

static void installCallbacksInBackendSos() {
  std::vector<std::string> paths;
  dl_iterate_phdr(&ocrBackendSoIterCallback, &paths);

  using LogSetFn = void (*)(ggml_log_callback, void*);
  using AbortSetFn = ggml_abort_callback_t (*)(ggml_abort_callback_t);

  for (const auto& soPath : paths) {
    void* handle = dlopen(soPath.c_str(), RTLD_NOW | RTLD_NOLOAD);
    if (handle == nullptr) {
      continue;
    }
    if (auto* fn = reinterpret_cast<LogSetFn>(dlsym(handle, "ggml_log_set"))) {
      fn(&ocrGgmlLogCallback, nullptr);
    }
    if (auto* fn = reinterpret_cast<AbortSetFn>(
            dlsym(handle, "ggml_set_abort_callback"))) {
      fn(&ocrGgmlAbortCallback);
    }
    dlclose(handle);
  }
}
#endif

// Load ggml backends exactly once per process. Appends BACKENDS_SUBDIR so
// the path points at the flat directory that actually contains the backend
// .so files (e.g. prebuilds/android-arm64/qvac__ocr-ggml/) rather than the
// prebuilds root. Mirrors LlamaLazyInitializeBackend / vla-ggml's approach.
void loadBackendsOnce(const std::string& backendsDir) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;
  static std::once_flag s_backendsOnce;

  std::call_once(s_backendsOnce, [&backendsDir]() {
    // Install callbacks in the main .bare copy BEFORE loading so that any
    // registration-time ggml log lines reach logcat.
    ggml_log_set(&ocrGgmlLogCallback, nullptr);
    ggml_set_abort_callback(&ocrGgmlAbortCallback);

    if (!backendsDir.empty()) {
      std::filesystem::path p(backendsDir);
#ifdef BACKENDS_SUBDIR
      p = (p / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
      QLOG(Priority::INFO, "ocr-ggml: loading backends from " + p.string());
      ggml_backend_load_all_from_path(p.string().c_str());
    } else {
      ggml_backend_load_all();
    }

#ifdef __ANDROID__
    // Patch callbacks into each backend .so's private ggml copy so that any
    // GGML_ASSERT inside the Vulkan/OpenCL backend reaches logcat.
    installCallbacksInBackendSos();
#endif
  });
}

} // namespace

namespace qvac_lib_infer_ocr_ggml {

namespace {

cv::Mat decodeOrWrapImage(const OcrInput& input) {
  if (input.isEncoded) {
    // cv::Mat constructor wants non-const void* but cv::imdecode does not
    // write through it.
    cv::Mat encoded(
        1,
        static_cast<int>(input.data.size()),
        CV_8UC1,
        const_cast<uint8_t*>( // NOLINT(cppcoreguidelines-pro-type-const-cast)
            input.data.data()));
    cv::Mat decoded = cv::imdecode(encoded, cv::IMREAD_COLOR);
    if (decoded.empty()) {
      throw std::runtime_error("ocr-ggml: failed to decode image (unsupported "
                               "format or corrupt data)");
    }
    // cv::imdecode returns BGR; the OCR pre-processing expects RGB.
    cv::cvtColor(decoded, decoded, cv::COLOR_BGR2RGB);
    return decoded;
  }

  if (input.imageWidth <= 0 || input.imageHeight <= 0 || input.data.empty()) {
    throw std::runtime_error(
        "ocr-ggml: raw image input requires positive width/height and data");
  }

  // Raw RGB bytes — wrap without copying, then clone so OcrInput can be safely
  // destroyed afterwards.
  // cv::Mat constructor wants non-const void* but we clone() before mutating.
  cv::Mat raw(
      input.imageHeight,
      input.imageWidth,
      CV_8UC3,
      const_cast<uint8_t*>( // NOLINT(cppcoreguidelines-pro-type-const-cast)
          input.data.data()));
  return raw.clone();
}

double elapsedMs(std::chrono::steady_clock::time_point start) {
  using namespace std::chrono;
  return duration_cast<duration<double, std::milli>>(
             steady_clock::now() - start)
      .count();
}

} // namespace

Pipeline::Pipeline(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    const std::string& pathDetector, const std::string& pathRecognizer,
    std::span<const std::string> langList, OcrConfig config)
    : config_(std::move(config)) {
  loadBackendsOnce(config_.backendsDir);

  if (config_.mode == PipelineMode::DOCTR) {
    doctrDetector_ =
        std::make_unique<doctr::ggml::pipeline::StepDoctrDetectionGGML>(
            pathDetector, config_.nThreads);

    doctrRecognizer_ =
        std::make_unique<doctr::ggml::pipeline::StepDoctrRecognitionGGML>(
            pathRecognizer, config_.recognizerBatchSize);
  } else {
    ggml_backend_dev_t cpuDev =
        ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    recognizerBackend_ =
        cpuDev ? ggml_backend_dev_init(cpuDev, nullptr) : nullptr;
    if (recognizerBackend_ == nullptr) {
      throw std::runtime_error(
          "ocr-ggml: failed to init CPU ggml backend for recognizer");
    }

    if (config_.nThreads >= 0) {
      const int effective =
          (config_.nThreads == 0)
              ? easyocr::ggml::pipeline::defaultPhysicalThreadCount()
              : config_.nThreads;
      ggml_backend_cpu_set_n_threads(recognizerBackend_, effective);
    }

    easyDetector_ =
        std::make_unique<easyocr::ggml::pipeline::StepDetectionInference>(
            pathDetector, config_.magRatio, config_.nThreads);

    easyBoxer_ = std::make_unique<easyocr::ggml::pipeline::StepBoundingBox>();

    easyocr::ggml::pipeline::StepRecognizeText::Config recogConfig(
        config_.defaultRotationAngles,
        config_.contrastRetry,
        config_.lowConfidenceThreshold,
        config_.recognizerBatchSize);

    easyRecognizer_ =
        std::make_unique<easyocr::ggml::pipeline::StepRecognizeText>(
            pathRecognizer, langList, recognizerBackend_, recogConfig);
  }
}

Pipeline::~Pipeline() {
  // Destroy steps first; their tensors live in buffers owned by backends.
  // For EASYOCR mode, the detector owns its own backend and we own the
  // recognizer's. For DOCTR mode, both steps own their backends internally.
  easyRecognizer_.reset();
  easyBoxer_.reset();
  easyDetector_.reset();
  doctrRecognizer_.reset();
  doctrDetector_.reset();

  if (recognizerBackend_ != nullptr) {
    ggml_backend_free(recognizerBackend_);
    recognizerBackend_ = nullptr;
  }
}

std::any Pipeline::process(const std::any& input) {
  if (const auto* asInput = std::any_cast<OcrInput>(&input)) {
    return processImage(*asInput);
  }
  throw std::runtime_error("ocr-ggml: invalid input type (expected OcrInput)");
}

Pipeline::Output Pipeline::processImage(const Input& input) {
  cancelFlag_.store(false, std::memory_order_relaxed);

  const auto t0 = std::chrono::steady_clock::now();

  cv::Mat img = decodeOrWrapImage(input);

  Output result = (config_.mode == PipelineMode::DOCTR)
                      ? processDoctr(img, input)
                      : processEasyOcr(img, input);

  lastProcessMs_ = elapsedMs(t0);
  return result;
}

Pipeline::Output
Pipeline::processEasyOcr(const cv::Mat& img, const Input& input) {
  easyocr::ggml::pipeline::PipelineContext ctx{
      .origImg = img,
      .paragraph = input.paragraph,
      .rotationAngles = input.rotationAngles,
      .boxMarginMultiplier = input.boxMarginMultiplier,
      .initialResizeRatio = 1.0F,
  };

  const auto tDetectStart = std::chrono::steady_clock::now();
  auto detOut = easyDetector_->process(ctx);
  lastDetectionMs_ = elapsedMs(tDetectStart);

  if (cancelFlag_.load(std::memory_order_relaxed)) {
    return {};
  }

  auto bbOut = easyBoxer_->process(detOut);
  lastNumBoxes_ =
      static_cast<int>(bbOut.alignedBoxes.size() + bbOut.unalignedBoxes.size());

  if (cancelFlag_.load(std::memory_order_relaxed)) {
    return {};
  }

  const auto tRecogStart = std::chrono::steady_clock::now();
  auto texts = easyRecognizer_->process(std::move(bbOut), &cancelFlag_);
  lastRecognitionMs_ = elapsedMs(tRecogStart);

  return texts;
}

Pipeline::Output
Pipeline::processDoctr(const cv::Mat& img, const Input& input) {
  doctr::ggml::pipeline::PipelineContext ctx{
      .origImg = img,
      .paragraph = false,
      .rotationAngles = std::nullopt,
      .boxMarginMultiplier = input.boxMarginMultiplier,
      .initialResizeRatio = 1.0F,
  };

  const auto tDetectStart = std::chrono::steady_clock::now();
  auto detOut = doctrDetector_->process(ctx);
  lastDetectionMs_ = elapsedMs(tDetectStart);
  lastNumBoxes_ = static_cast<int>(detOut.polygons.size());

  if (cancelFlag_.load(std::memory_order_relaxed)) {
    return {};
  }

  const auto tRecogStart = std::chrono::steady_clock::now();
  auto texts = doctrRecognizer_->process(std::move(detOut), &cancelFlag_);
  lastRecognitionMs_ = elapsedMs(tRecogStart);

  return texts;
}

qvac_lib_inference_addon_cpp::RuntimeStats Pipeline::runtimeStats() const {
  // Seconds (totalTime/decodeTime/encodeTime) and milliseconds (TTFT) —
  // same unit convention as TranslationModel so JS-side stats objects
  // remain comparable across qvac inference addons.
  const double totalTimeSec = lastProcessMs_ / 1000.0;
  const double detectionTimeSec = lastDetectionMs_ / 1000.0;
  const double recognitionTimeSec = lastRecognitionMs_ / 1000.0;

  return {
      std::make_pair("totalTime", std::variant<double, int64_t>(totalTimeSec)),
      std::make_pair(
          "detectionTime", std::variant<double, int64_t>(detectionTimeSec)),
      std::make_pair(
          "recognitionTime", std::variant<double, int64_t>(recognitionTimeSec)),
      std::make_pair(
          "numBoxes",
          std::variant<double, int64_t>(static_cast<int64_t>(lastNumBoxes_)))};
}

} // namespace qvac_lib_infer_ocr_ggml

// NOLINTEND(readability-identifier-naming,readability-identifier-length)

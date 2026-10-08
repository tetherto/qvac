#include "OcrFit.hpp"

#include <algorithm>
#include <cctype>
#include <memory>
#include <sstream>
#include <string>

#include <ggml-backend.h>
#include <ggml.h>
#include <gguf.h>

#include "OcrBackendSelection.hpp"
#include "OcrLazyInitializeBackend.hpp"

namespace qvac_lib_infer_ocr_ggml::ocr_fit {
namespace {

constexpr uint64_t K_MI_B = 1024ULL * 1024ULL;
constexpr uint64_t K_WEIGHT_COPIES_BYTES_PER_ELEMENT = 16;
constexpr uint64_t K_FIXED_WEIGHT_OVERHEAD_BYTES = 64 * K_MI_B;
constexpr uint64_t K_MAX_JS_SAFE_INTEGER = 9007199254740991ULL;

bool addChecked(uint64_t& total, uint64_t value) {
  if (value > K_MAX_JS_SAFE_INTEGER - total)
    return false;
  total += value;
  return true;
}

bool isMaliVulkan(const ocr_backend_selection::BackendSelection& selected) {
  if (!ocr_backend_selection::isVulkanBackendName(selected.backendName))
    return false;
  std::string description = selected.backendDescription;
  std::ranges::transform(
      description, description.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
      });
  return description.find("mali") != std::string::npos ||
         description.find("immortalis") != std::string::npos;
}

bool usesMultipleDevices(
    const OcrConfig& config,
    const ocr_backend_selection::BackendSelection& selected) {
  if (config.mode != PipelineMode::DOCTR)
    return false;

  ggml_backend_dev_t detectionDevice = selected.device;
  if (config.detectionBackendDevice.has_value()) {
    detectionDevice =
        ocr_backend_selection::selectBackendDevice(
            *config.detectionBackendDevice, config.gpuDevice, config.mainGpu)
            .device;
  } else if (isMaliVulkan(selected)) {
    detectionDevice =
        ocr_backend_selection::selectBackendDevice(BackendDevice::CPU).device;
  }

  const bool recognizerAssisted =
      !selected.selectedIsCpu() &&
      config.recognizerCpuAssist.value_or(isMaliVulkan(selected));
  return detectionDevice != selected.device || recognizerAssisted;
}

OcrFitResult unavailable(const std::string& reason) {
  OcrFitResult result;
  result.reason = reason;
  result.report = "OCR weight-load fit unavailable: " + reason;
  return result;
}

} // namespace

std::optional<OcrFitFootprint>
inspectOcrGguf(const std::string& path, const char* requiredTensor) {
  struct ggml_context* rawContext = nullptr;
  const gguf_init_params params{.no_alloc = true, .ctx = &rawContext};
  gguf_context* rawGguf = gguf_init_from_file(path.c_str(), params);
  std::unique_ptr<struct ggml_context, decltype(&ggml_free)> context(
      rawContext, ggml_free);
  std::unique_ptr<gguf_context, decltype(&gguf_free)> gguf(rawGguf, gguf_free);
  if (!gguf || !context || gguf_get_n_tensors(gguf.get()) <= 0 ||
      ggml_get_tensor(context.get(), requiredTensor) == nullptr) {
    return std::nullopt;
  }

  OcrFitFootprint footprint;
  for (int64_t i = 0; i < gguf_get_n_tensors(gguf.get()); ++i) {
    const char* name = gguf_get_tensor_name(gguf.get(), i);
    const struct ggml_tensor* tensor =
        name == nullptr ? nullptr : ggml_get_tensor(context.get(), name);
    if (tensor == nullptr)
      return std::nullopt;
    const int64_t elements = ggml_nelements(tensor);
    if (elements <= 0 ||
        !addChecked(
            footprint.sourceBytes,
            static_cast<uint64_t>(ggml_nbytes(tensor))) ||
        !addChecked(footprint.elements, static_cast<uint64_t>(elements))) {
      return std::nullopt;
    }
  }
  return footprint;
}

OcrFitResult assessOcrFit(
    const std::string& detectorPath, const std::string& recognizerPath,
    const OcrConfig& config, uint64_t marginBytes) {
  const bool doctr = config.mode == PipelineMode::DOCTR;
  const auto detector = inspectOcrGguf(
      detectorPath,
      doctr ? "dbnet.prob_head.0.weight" : "basenet.slice1.0.weight");
  const auto recognizer = inspectOcrGguf(
      recognizerPath, doctr ? "crnn.features.0.0.weight" : "Prediction.bias");
  if (!detector || !recognizer)
    return unavailable("model-unreadable");

  uint64_t sourceBytes = detector->sourceBytes;
  uint64_t elements = detector->elements;
  if (!addChecked(sourceBytes, recognizer->sourceBytes) ||
      !addChecked(elements, recognizer->elements) ||
      elements > (K_MAX_JS_SAFE_INTEGER - K_FIXED_WEIGHT_OVERHEAD_BYTES) /
                     K_WEIGHT_COPIES_BYTES_PER_ELEMENT) {
    return unavailable("footprint-overflow");
  }
  const uint64_t upperBytes = elements * K_WEIGHT_COPIES_BYTES_PER_ELEMENT +
                              K_FIXED_WEIGHT_OVERHEAD_BYTES;

  // Backend registration and selection match Pipeline construction. No model
  // or inference graph is created by this handle.
  OcrBackendsHandle backends(config.backendsDir);
  const auto selected = ocr_backend_selection::selectBackendDevice(
      config.backendDevice, config.gpuDevice, config.mainGpu);
  if (selected.device == nullptr)
    return unavailable("device-unavailable");

  const bool cpu = selected.selectedIsCpu();
  if (usesMultipleDevices(config, selected))
    return unavailable("unsupported-config");

  OcrFitResult result;
  result.deviceName = selected.backendName;
  result.weightsBytes = upperBytes;
  result.deviceBytes = cpu ? 0 : upperBytes;
  result.hostBytes = upperBytes; // Includes conservative GGUF staging copies.

  size_t freeBytes = 0;
  size_t totalBytes = 0;
  ggml_backend_dev_memory(selected.device, &freeBytes, &totalBytes);
  if (freeBytes == 0 ||
      static_cast<uint64_t>(freeBytes) > K_MAX_JS_SAFE_INTEGER ||
      static_cast<uint64_t>(totalBytes) > K_MAX_JS_SAFE_INTEGER) {
    result.reason = "device-memory-unavailable";
    result.report =
        "OCR weight-load fit unavailable: backend memory is unknown; "
        "excludes image and inference-graph memory";
    return result;
  }

  result.deviceFreeBytes = static_cast<uint64_t>(freeBytes);
  result.deviceTotalBytes = static_cast<uint64_t>(totalBytes);

  if (marginBytes < result.deviceFreeBytes) {
    const uint64_t budget = result.deviceFreeBytes - marginBytes;
    if (upperBytes <= budget) {
      result.status = "fits";
      result.reason = "weights-fit";
    } else if (cpu && sourceBytes > budget) {
      // Source tensors alone are unavoidable during CPU weight loading.
      result.status = "does-not-fit";
      result.reason = "source-weights-exceed-memory";
    }
  }

  std::ostringstream report;
  report << "OCR weight-load only; source=" << sourceBytes
         << " bytes, conservative estimate=" << upperBytes
         << " bytes, free=" << result.deviceFreeBytes
         << " bytes, margin=" << marginBytes
         << " bytes; excludes image and inference-graph memory";
  result.report = report.str();
  return result;
}

} // namespace qvac_lib_infer_ocr_ggml::ocr_fit

#include "OcrFit.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <memory>
#include <string>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
#include <os/proc.h>
#endif
#endif

#include <ggml-backend.h>
#include <ggml.h>
#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>

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

[[noreturn]] void throwFitError(
    qvac_errors::general_error::GeneralErrorCode code,
    const std::string& message) {
  throw qvac_errors::StatusError(code, "assessFit: " + message);
}

// The PCI bus ID when the backend reports one, so the same GPU matches across
// addons built on different backends; the device name otherwise.
//
// Unified marks memory the host owns: the CPU, an integrated GPU, a GPU that
// says it shares host memory, Android's OpenCL GPU, and a device that reports
// no memory of its own. A unified device that reports none takes the CPU's
// figures.
FitDevice fitDevice(ggml_backend_dev_t device, uint64_t usedBytes) {
  ggml_backend_dev_props props{};
  ggml_backend_dev_get_props(device, &props);
  uint64_t freeBytes = static_cast<uint64_t>(props.memory_free);
  uint64_t totalBytes = static_cast<uint64_t>(props.memory_total);
  const bool reportsNoMemory = totalBytes == 0;
#if defined(__ANDROID__)
  const char* registry =
      ggml_backend_reg_name(ggml_backend_dev_backend_reg(device));
  const bool androidOpenCl =
      registry != nullptr && std::strcmp(registry, "OpenCL") == 0;
#else
  const bool androidOpenCl = false;
#endif
  const bool unified = props.memory_unified ||
                       props.type == GGML_BACKEND_DEVICE_TYPE_IGPU ||
                       props.type == GGML_BACKEND_DEVICE_TYPE_CPU ||
                       androidOpenCl || reportsNoMemory;
  if (unified && reportsNoMemory) {
    if (ggml_backend_dev_t host =
            ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU)) {
      size_t hostFree = 0;
      size_t hostTotal = 0;
      ggml_backend_dev_memory(host, &hostFree, &hostTotal);
      freeBytes = static_cast<uint64_t>(hostFree);
      totalBytes = static_cast<uint64_t>(hostTotal);
    }
  }
  return {
      props.device_id != nullptr ? props.device_id : props.name,
      props.name,
      unified,
      usedBytes,
      freeBytes,
      totalBytes};
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
  if (!detector) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "cannot read the detector " + detectorPath);
  }
  if (!recognizer) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "cannot read the recognizer " + recognizerPath);
  }

  uint64_t sourceBytes = detector->sourceBytes;
  uint64_t elements = detector->elements;
  if (!addChecked(sourceBytes, recognizer->sourceBytes) ||
      !addChecked(elements, recognizer->elements) ||
      elements > (K_MAX_JS_SAFE_INTEGER - K_FIXED_WEIGHT_OVERHEAD_BYTES) /
                     K_WEIGHT_COPIES_BYTES_PER_ELEMENT) {
    throwFitError(
        qvac_errors::general_error::InvalidArgument,
        "the models' footprint overflows a safe integer");
  }
  const uint64_t upperBytes = elements * K_WEIGHT_COPIES_BYTES_PER_ELEMENT +
                              K_FIXED_WEIGHT_OVERHEAD_BYTES;

  // Backend registration and selection match Pipeline construction. No model
  // or inference graph is created by this handle.
  OcrBackendsHandle backends(config.backendsDir);
  const auto selected = ocr_backend_selection::selectBackendDevice(
      config.backendDevice, config.gpuDevice, config.mainGpu);
  if (selected.device == nullptr) {
    throwFitError(
        qvac_errors::general_error::InternalError,
        "no backend device is available");
  }

  // A detector and recognizer on different devices are not projected.
  OcrFitResult result;
  if (usesMultipleDevices(config, selected)) {
    return result;
  }

  // The weights land on the selected device, then the host CPU row. A discrete
  // GPU's load also holds the GGUF staging copies in host memory while it
  // loads; on a device that shares host memory those copies are the same
  // memory, so its host row carries nothing more. A load on the CPU is one
  // row. A verdict always carries the host row, so a registry without a CPU
  // device to name it by leaves the load unsized.
  const bool cpu = selected.selectedIsCpu();
  std::vector<FitDevice> rows{fitDevice(selected.device, upperBytes)};
  if (!cpu) {
    ggml_backend_dev_t host =
        ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (host == nullptr) {
      return result;
    }
    rows.push_back(fitDevice(host, rows.front().unified ? 0 : upperBytes));
  }
  for (const FitDevice& row : rows) {
    if (row.freeBytes == 0 || row.freeBytes > K_MAX_JS_SAFE_INTEGER ||
        row.totalBytes > K_MAX_JS_SAFE_INTEGER) {
      return result;
    }
  }

#if defined(__APPLE__) && TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
  capToAppLimit(rows, static_cast<uint64_t>(os_proc_available_memory()));
#endif

  result.status = ocrVerdict(rows, sourceBytes, marginBytes, cpu);
  if (result.status != "unknown") {
    result.devices = std::move(rows);
  }
  return result;
}

} // namespace qvac_lib_infer_ocr_ggml::ocr_fit

#include "OcrBackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <format>
#include <string>
#include <string_view>

#include <ggml-backend.h>

// Uses the package logging shim (see easyocr/pipeline/qlog.hpp). The shim is a
// no-op on desktop builds, so the authoritative, programmatically observable
// surface for the selected backend is `Pipeline::backendInfo()` /
// `getBackendInfo` (exposed to JS) — these log lines exist for parity with the
// rest of the package and to reach Android logcat via the ggml log callback.
#include "easyocr/pipeline/qlog.hpp"

namespace qvac_lib_infer_ocr_ggml::ocr_backend_selection {

namespace {

using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

std::string toLower(std::string_view value) {
  std::string lower(value);
  std::ranges::transform(lower, lower.begin(), [](unsigned char chr) {
    return static_cast<char>(std::tolower(chr));
  });
  return lower;
}

const char* deviceTypeName(enum ggml_backend_dev_type type) {
  switch (type) {
  case GGML_BACKEND_DEVICE_TYPE_CPU:
    return "CPU";
  case GGML_BACKEND_DEVICE_TYPE_GPU:
    return "GPU";
  case GGML_BACKEND_DEVICE_TYPE_IGPU:
    return "IGPU";
  case GGML_BACKEND_DEVICE_TYPE_ACCEL:
    return "ACCEL";
  default:
    return "UNKNOWN";
  }
}

// First GPU/iGPU device whose backend name satisfies `matches`, or nullptr if
// none is registered. Used to resolve both Vulkan and Metal requests.
//
// Matches against BOTH the device name and its backend-registration name: ggml
// names Vulkan devices "Vulkan0" (so the device name carries the backend), but
// Metal devices are named "MTL0"/"MTL1" while the backing registration is named
// "Metal". Checking the reg name lets the Metal request resolve correctly.
ggml_backend_dev_t findGpuDeviceByName(bool (*matches)(std::string_view)) {
  const size_t count = ggml_backend_dev_count();
  for (size_t i = 0; i < count; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (dev == nullptr) {
      continue;
    }
    const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
    if (type != GGML_BACKEND_DEVICE_TYPE_GPU &&
        type != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    const char* devNameRaw = ggml_backend_dev_name(dev);
    if (devNameRaw != nullptr && matches(devNameRaw)) {
      return dev;
    }
    ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
    const char* regNameRaw =
        (reg != nullptr) ? ggml_backend_reg_name(reg) : nullptr;
    if (regNameRaw != nullptr && matches(regNameRaw)) {
      return dev;
    }
  }
  return nullptr;
}

BackendSelection selectCpu(BackendSelection sel) {
  ggml_backend_dev_t cpuDev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  sel.device = cpuDev;
  sel.backendDevice = "CPU";
  if (cpuDev != nullptr) {
    const char* nameRaw = ggml_backend_dev_name(cpuDev);
    sel.backendName = (nameRaw != nullptr) ? nameRaw : "CPU";
  } else {
    sel.backendName = "CPU";
  }
  return sel;
}

} // namespace

bool isVulkanBackendName(std::string_view backendName) {
  return toLower(backendName).find("vulkan") != std::string::npos;
}

bool isMetalBackendName(std::string_view backendName) {
  // ggml's Metal backend identifies as "MTL": the backend registration is named
  // "MTL" and devices are "MTL0"/"MTL1"… (the human-readable description
  // carries the GPU model, e.g. "Apple M3 Ultra", and varies per device). Match
  // the stable "MTL" prefix so selection is generic across all Apple GPUs; also
  // accept a "metal" prefix defensively in case a future ggml renames the
  // backend. Prefix (not substring) matching mirrors tts-ggml /
  // transcription-parakeet and avoids false positives on unrelated names that
  // merely contain "mtl".
  const std::string lower = toLower(backendName);
  return lower.rfind("mtl", 0) == 0 || lower.rfind("metal", 0) == 0;
}

namespace {

// Resolve a GPU-backed request (Vulkan or Metal). On success fills `sel` with
// the matched device and returns true; otherwise records a CPU-fallback reason
// and returns false (the caller then resolves the CPU device).
bool trySelectGpu(
    BackendSelection& sel, std::string_view label,
    bool (*matches)(std::string_view)) {
  ggml_backend_dev_t dev = findGpuDeviceByName(matches);
  if (dev != nullptr) {
    sel.device = dev;
    const char* nameRaw = ggml_backend_dev_name(dev);
    sel.backendName =
        (nameRaw != nullptr) ? std::string(nameRaw) : std::string(label);
    sel.backendDevice = deviceTypeName(ggml_backend_dev_type(dev));
    const char* descRaw = ggml_backend_dev_description(dev);
    QLOG(
        Priority::INFO,
        std::format(
            "ocr-ggml: selected {} backend '{}' ({}, {})",
            label,
            sel.backendName,
            sel.backendDevice,
            descRaw != nullptr ? descRaw : ""));
    return true;
  }
  sel.fallbackReason = std::format(
      "{} backend requested but no {}-capable GPU device was found; falling "
      "back to CPU",
      label,
      label);
  QLOG(Priority::WARN, std::format("ocr-ggml: {}", sel.fallbackReason));
  return false;
}

} // namespace

BackendSelection selectBackendDevice(BackendDevice requested) {
  BackendSelection sel;
  switch (requested) {
  case BackendDevice::VULKAN:
    sel.requested = "vulkan";
    if (trySelectGpu(sel, "Vulkan", isVulkanBackendName)) {
      return sel;
    }
    break;
  case BackendDevice::METAL:
    sel.requested = "metal";
    if (trySelectGpu(sel, "Metal", isMetalBackendName)) {
      return sel;
    }
    break;
  case BackendDevice::CPU:
    sel.requested = "cpu";
    break;
  default:
    // Defensive: a BackendDevice value added without updating this switch must
    // not silently masquerade as an explicit CPU request. Record the fallback
    // so getBackendInfo() surfaces the gap instead of reporting a clean CPU.
    sel.requested = "unknown";
    sel.fallbackReason = "Unsupported backendDevice value; falling back to CPU";
    QLOG(Priority::WARN, std::format("ocr-ggml: {}", sel.fallbackReason));
    break;
  }

  sel = selectCpu(std::move(sel));
  QLOG(
      Priority::INFO,
      std::format("ocr-ggml: using CPU backend '{}'", sel.backendName));
  return sel;
}

} // namespace qvac_lib_infer_ocr_ggml::ocr_backend_selection

#include "OcrBackendSelection.hpp"

#include <algorithm>
#include <cctype>
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

// First Vulkan-capable GPU/iGPU device, or nullptr if none is registered.
ggml_backend_dev_t findVulkanGpuDevice() {
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
    const char* nameRaw = ggml_backend_dev_name(dev);
    if (isVulkanBackendName(nameRaw != nullptr ? nameRaw : "")) {
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

BackendSelection selectBackendDevice(BackendDevice requested) {
  BackendSelection sel;
  sel.requested = (requested == BackendDevice::VULKAN) ? "vulkan" : "cpu";

  if (requested == BackendDevice::VULKAN) {
    ggml_backend_dev_t vulkanDev = findVulkanGpuDevice();
    if (vulkanDev != nullptr) {
      sel.device = vulkanDev;
      const char* nameRaw = ggml_backend_dev_name(vulkanDev);
      sel.backendName = (nameRaw != nullptr) ? nameRaw : "vulkan";
      sel.backendDevice = deviceTypeName(ggml_backend_dev_type(vulkanDev));
      const char* descRaw = ggml_backend_dev_description(vulkanDev);
      QLOG(
          Priority::INFO,
          std::string("ocr-ggml: selected Vulkan backend '") + sel.backendName +
              "' (" + sel.backendDevice + ", " +
              (descRaw != nullptr ? descRaw : "") + ")");
      return sel;
    }
    sel.fallbackReason =
        "Vulkan backend requested but no Vulkan-capable GPU device was found; "
        "falling back to CPU";
    QLOG(Priority::WARN, std::string("ocr-ggml: ") + sel.fallbackReason);
  }

  sel = selectCpu(std::move(sel));
  QLOG(
      Priority::INFO,
      std::string("ocr-ggml: using CPU backend '") + sel.backendName + "'");
  return sel;
}

} // namespace qvac_lib_infer_ocr_ggml::ocr_backend_selection

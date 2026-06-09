#include "OcrBackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

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

// True when a ggml device description identifies a Qualcomm Adreno GPU (the
// description reads e.g. "Adreno (TM) 830"). Adreno's Vulkan compute path is
// numerically broken: vla-ggml measured cos-sim ~0.73 vs reference on Adreno
// 830 (Galaxy S25 Ultra) while every other Vulkan/Metal target sits >0.999.
// It does not crash — it silently produces wrong results — so auto-selection
// must avoid it and fall back to CPU. (Adreno's OpenCL path is fine, but
// ocr-ggml does not wire OpenCL today.)
bool isAdrenoDescription(std::string_view description) {
  return toLower(description).find("adreno") != std::string::npos;
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

// A GPU/iGPU device matched against the requested backend, retaining its ggml
// enumeration index so the resolved `deviceIndex` can be reported to JS.
struct MatchingDevice {
  ggml_backend_dev_t dev{nullptr};
  size_t index{0}; // index passed to ggml_backend_dev_get
  enum ggml_backend_dev_type type { GGML_BACKEND_DEVICE_TYPE_GPU };
  std::string name;
  std::string description;
};

// True for GPU devices whose ggml backend path is known to be numerically
// broken, so selection must skip them and fall back to CPU rather than emit
// wrong results. Currently: Qualcomm Adreno via Vulkan — `vla-ggml` measured
// cos-sim ~0.73 vs PyTorch on Adreno 830 Vulkan, while every other accepted
// Vulkan/Metal target (Apple Metal, NVIDIA, Intel Iris, Mali) sits >0.999.
//
// The defect is specific to Adreno's *Vulkan* path, so the check is scoped to
// the Vulkan backend rather than the GPU name alone: Adreno's OpenCL backend is
// numerically sound, and OpenCL support for Adreno is planned, so an
// Adreno-via-OpenCL device must NOT be rejected here. Apple Metal devices are
// never Adreno, so the Metal path is unaffected.
bool isBrokenGpuDevice(ggml_backend_dev_t dev) {
  const char* descRaw = ggml_backend_dev_description(dev);
  if (descRaw == nullptr ||
      toLower(descRaw).find("adreno") == std::string::npos) {
    return false;
  }
  // Adreno is only broken under Vulkan; let OpenCL (and any future backend)
  // through. Check both the device name ("Vulkan0") and the reg name
  // ("Vulkan"), mirroring enumerateMatchingDevices's matching.
  const char* devNameRaw = ggml_backend_dev_name(dev);
  ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
  const char* regNameRaw =
      (reg != nullptr) ? ggml_backend_reg_name(reg) : nullptr;
  return (devNameRaw != nullptr && isVulkanBackendName(devNameRaw)) ||
         (regNameRaw != nullptr && isVulkanBackendName(regNameRaw));
}

// All GPU/iGPU devices whose backend name satisfies `matches`, in ggml
// enumeration order. Used to resolve both Vulkan and Metal requests.
//
// Matches against BOTH the device name and its backend-registration name: ggml
// names Vulkan devices "Vulkan0" (so the device name carries the backend), but
// Metal devices are named "MTL0"/"MTL1" while the backing registration is named
// "Metal". Checking the reg name lets the Metal request resolve correctly.
//
// A name-matched device that `isBrokenGpuDevice()` rejects is skipped (the loop
// keeps looking; if no usable GPU remains, the caller falls back to CPU).
std::vector<MatchingDevice>
enumerateMatchingDevices(bool (*matches)(std::string_view)) {
  std::vector<MatchingDevice> result;
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
    bool nameMatches = devNameRaw != nullptr && matches(devNameRaw);
    if (!nameMatches) {
      ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
      const char* regNameRaw =
          (reg != nullptr) ? ggml_backend_reg_name(reg) : nullptr;
      nameMatches = regNameRaw != nullptr && matches(regNameRaw);
    }
    if (!nameMatches) {
      continue;
    }
    if (isBrokenGpuDevice(dev)) {
      const char* descRaw = ggml_backend_dev_description(dev);
      QLOG(
          Priority::WARN,
          std::string("ocr-ggml: skipping known-broken GPU '") +
              (descRaw != nullptr ? descRaw : "?") +
              "' (numerically unreliable backend); falling back to CPU");
      continue;
    }
    const char* descRaw = ggml_backend_dev_description(dev);
    result.push_back(
        MatchingDevice{
            .dev = dev,
            .index = i,
            .type = type,
            .name = (devNameRaw != nullptr) ? std::string(devNameRaw)
                                            : std::string(),
            .description =
                (descRaw != nullptr) ? std::string(descRaw) : std::string()});
  }
  return result;
}

// Pick which matching device to use. With an explicit `gpuDevice` index, the
// Nth matching device (0-based) is selected, or nullopt when out of range.
// Without one, prefer the first discrete GPU and otherwise the first matching
// (integrated) device. Returns nullopt when no device matched.
std::optional<size_t> chooseMatchingDevice(
    const std::vector<MatchingDevice>& matching, std::optional<int> gpuDevice) {
  if (matching.empty()) {
    return std::nullopt;
  }
  if (gpuDevice.has_value()) {
    const int idx = *gpuDevice;
    if (idx < 0 || static_cast<size_t>(idx) >= matching.size()) {
      return std::nullopt;
    }
    return static_cast<size_t>(idx);
  }
  for (size_t i = 0; i < matching.size(); ++i) {
    if (matching[i].type == GGML_BACKEND_DEVICE_TYPE_GPU) {
      return i;
    }
  }
  return static_cast<size_t>(0);
}

// Human-readable dump of the enumerated matching devices for logging.
std::string describeMatchingDevices(
    std::string_view label, const std::vector<MatchingDevice>& matching) {
  std::string msg = "ocr-ggml: " + std::string(label) + " matching devices (" +
                    std::to_string(matching.size()) + "):";
  for (const auto& md : matching) {
    msg += " [" + std::to_string(md.index) + " " + deviceTypeName(md.type) +
           " '" + md.name + "'";
    if (!md.description.empty()) {
      msg += " " + md.description;
    }
    msg += "]";
  }
  return msg;
}

BackendSelection selectCpu(BackendSelection sel) {
  ggml_backend_dev_t cpuDev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  sel.device = cpuDev;
  sel.backendDevice = "CPU";
  sel.deviceIndex = -1;
  if (cpuDev != nullptr) {
    const char* nameRaw = ggml_backend_dev_name(cpuDev);
    sel.backendName = (nameRaw != nullptr) ? nameRaw : "CPU";
    const char* descRaw = ggml_backend_dev_description(cpuDev);
    sel.backendDescription = (descRaw != nullptr) ? descRaw : "";
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
// the matched device (including its ggml index and description) and returns
// true; otherwise records a CPU-fallback reason and returns false (the caller
// then resolves the CPU device).
//
// `gpuDevice` selects the Nth matching device (0-based); when unset, a discrete
// GPU is preferred over an integrated one.
//
// `rejectAdreno` filters out Adreno GPUs on the AUTO path (no explicit
// `gpuDevice`): their Vulkan path is numerically broken (see
// `isAdrenoDescription`), so auto-selection must skip them. An explicit
// `gpuDevice` index is treated as a deliberate override and is honoured as-is
// (escape hatch for benchmarking / driver bring-up on Adreno).
bool trySelectGpu(
    BackendSelection& sel, std::string_view label,
    bool (*matches)(std::string_view), std::optional<int> gpuDevice,
    bool rejectAdreno) {
  const std::vector<MatchingDevice> matching =
      enumerateMatchingDevices(matches);
  QLOG(Priority::INFO, describeMatchingDevices(label, matching));

  // On the auto path, drop Adreno devices so a numerically-broken Adreno Vulkan
  // GPU never gets silently selected. The explicit-index path keeps the full
  // list so a caller can still force an Adreno device on purpose.
  std::vector<MatchingDevice> candidates;
  if (rejectAdreno && !gpuDevice.has_value()) {
    for (const auto& md : matching) {
      if (isAdrenoDescription(md.description)) {
        QLOG(
            Priority::WARN,
            std::string("ocr-ggml: skipping Adreno ") + std::string(label) +
                " device '" + md.name + "' (" + md.description +
                ") — Adreno's Vulkan path is numerically broken; will fall "
                "back to CPU unless another GPU is available");
        continue;
      }
      candidates.push_back(md);
    }
  } else {
    candidates = matching;
  }

  const std::optional<size_t> chosen =
      chooseMatchingDevice(candidates, gpuDevice);
  if (!chosen.has_value()) {
    if (gpuDevice.has_value()) {
      sel.fallbackReason =
          std::string(label) + " backend requested with gpuDevice index " +
          std::to_string(*gpuDevice) + " but only " +
          std::to_string(candidates.size()) +
          " matching device(s) were found; falling back to CPU";
    } else if (!matching.empty() && candidates.empty()) {
      sel.fallbackReason =
          std::string(label) +
          " backend requested but the only matching device(s) are Adreno, "
          "whose Vulkan path is numerically broken; falling back to CPU";
    } else {
      sel.fallbackReason = std::string(label) + " backend requested but no " +
                           std::string(label) +
                           "-capable GPU device was found; falling back to CPU";
    }
    QLOG(Priority::WARN, std::string("ocr-ggml: ") + sel.fallbackReason);
    return false;
  }

  const MatchingDevice& md = candidates[*chosen];
  sel.device = md.dev;
  sel.backendName = !md.name.empty() ? md.name : std::string(label);
  sel.backendDevice = deviceTypeName(md.type);
  sel.deviceIndex = static_cast<int>(md.index);
  sel.backendDescription = md.description;
  QLOG(
      Priority::INFO,
      std::string("ocr-ggml: selected ") + std::string(label) + " backend '" +
          sel.backendName + "' (" + sel.backendDevice + ", " + md.description +
          ") at ggml device index " + std::to_string(md.index));
  return true;
}

} // namespace

BackendSelection
selectBackendDevice(BackendDevice requested, std::optional<int> gpuDevice) {
  BackendSelection sel;
  switch (requested) {
  case BackendDevice::VULKAN:
    sel.requested = "vulkan";
    // rejectAdreno = true: Adreno Vulkan is numerically broken (auto-skip).
    if (trySelectGpu(sel, "Vulkan", isVulkanBackendName, gpuDevice, true)) {
      return sel;
    }
    break;
  case BackendDevice::METAL:
    sel.requested = "metal";
    // Metal is Apple-only; no Adreno devices to guard against.
    if (trySelectGpu(sel, "Metal", isMetalBackendName, gpuDevice, false)) {
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
    QLOG(Priority::WARN, std::string("ocr-ggml: ") + sel.fallbackReason);
    break;
  }

  sel = selectCpu(std::move(sel));
  QLOG(
      Priority::INFO,
      std::string("ocr-ggml: using CPU backend '") + sel.backendName + "'");
  return sel;
}

} // namespace qvac_lib_infer_ocr_ggml::ocr_backend_selection

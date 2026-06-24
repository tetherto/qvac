#pragma once

// ggml backend-device selection for ocr-ggml.
//
// Modelled on `packages/vla-ggml/addon/src/utils/BackendSelection.cpp`: after
// the ggml backends have been loaded (see `OcrLazyInitializeBackend`), the
// `Pipeline` asks this helper to resolve the `ggml_backend_dev_t` that every
// inference step should run on, given the caller's requested `BackendDevice`.
//
//   - `BackendDevice::VULKAN` -> the first Vulkan-capable GPU/iGPU device
//     (backend name contains "vulkan", case-insensitive). When none is present
//     the result falls back to the CPU device and records a `fallbackReason`.
//     Adreno GPUs are skipped on the auto path (their Vulkan compute path is
//     numerically broken); an explicit `gpuDevice` index overrides this and can
//     still force an Adreno device on purpose.
//   - `BackendDevice::METAL` -> the first Metal-capable GPU device (backend
//     name begins with "MTL"/"metal", case-insensitive; Apple only). Same
//     CPU-fallback behaviour as Vulkan when no Metal device is present.
//   - `BackendDevice::OPENCL` -> the first OpenCL-capable GPU device (backend
//     name contains "opencl", case-insensitive; primarily Android/Adreno).
//     Unlike Vulkan, Adreno devices are NOT skipped on the auto path: OpenCL is
//     Adreno's sound compute path. Same CPU-fallback behaviour when no OpenCL
//     device is present.
//   - `BackendDevice::CPU` (default) -> the CPU device.
//
// The returned device is then handed to each step's `ggml_backend_dev_init`.
// Thread-count tuning (`ggml_backend_set_n_threads`) is only meaningful for the
// CPU device, so callers gate it on `selectedIsCpu()`.

#include <optional>
#include <string>
#include <string_view>

#include <ggml-backend.h>

#include "OcrTypes.hpp"

namespace qvac_lib_infer_ocr_ggml::ocr_backend_selection {

// Outcome of a backend-device selection. `device` is the resolved
// `ggml_backend_dev_t` to initialise (never null on a host with a CPU backend);
// the string fields are surfaced to JS for diagnostics / logging.
struct BackendSelection {
  ggml_backend_dev_t device{nullptr};
  // Requested device as a lowercase string ("cpu" | "vulkan" | "metal").
  std::string requested;
  // Resolved device-type string ("CPU" | "GPU" | "IGPU" | "ACCEL").
  std::string backendDevice;
  // ggml backend/device name of the resolved device (e.g. "Vulkan0", "CPU").
  std::string backendName;
  // ggml device index (the `i` passed to `ggml_backend_dev_get`) of the
  // resolved device, or -1 when the CPU backend was selected (including
  // fallback). Surfaced to JS so callers can identify which physical device a
  // multi-GPU host ran on.
  int deviceIndex{-1};
  // Human-readable device description (e.g. "NVIDIA GeForce RTX 4090",
  // "Apple M3 Ultra"); empty when ggml provides none.
  std::string backendDescription;
  // Empty when the requested device was selected as-is; otherwise a
  // human-readable explanation of why the selection fell back to CPU.
  std::string fallbackReason;

  // True when the resolved device is the CPU device.
  [[nodiscard]] bool selectedIsCpu() const { return backendDevice == "CPU"; }
};

// Resolve the backend device for `requested`, enumerating the loaded ggml
// devices. Must be called after backends have been loaded. Logs the outcome
// via the package logging macros.
//
// `gpuDevice` is an optional 0-based index into the GPU/iGPU devices that match
// the requested backend, in ggml enumeration order. When set, the Nth matching
// device is selected; an out-of-range index falls back to CPU with a clear
// reason. When unset, selection prefers a discrete GPU
// (`GGML_BACKEND_DEVICE_TYPE_GPU`) and otherwise the first integrated GPU. The
// option is ignored for `BackendDevice::CPU`.
BackendSelection selectBackendDevice(
    BackendDevice requested, std::optional<int> gpuDevice = std::nullopt);

// True if the backend name contains "vulkan" (case-insensitive). Exposed for
// unit testing / reuse.
[[nodiscard]] bool isVulkanBackendName(std::string_view backendName);

// True if the backend name begins with "MTL" or "metal" (case-insensitive) —
// matches both the ggml device name ("MTL0"/"MTL1") and the "Metal" backend
// registration name. Exposed for unit testing / reuse.
[[nodiscard]] bool isMetalBackendName(std::string_view backendName);

// True if the backend name contains "opencl" (case-insensitive) — matches both
// the ggml OpenCL device name ("GPUOpenCL") and the "OpenCL" backend
// registration name. Exposed for unit testing / reuse.
[[nodiscard]] bool isOpenCLBackendName(std::string_view backendName);

} // namespace qvac_lib_infer_ocr_ggml::ocr_backend_selection

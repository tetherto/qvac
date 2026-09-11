// NOLINTBEGIN
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <ranges>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>

#include <ggml-backend.h>
#include <ggml.h>

#ifdef _WIN32
#include <windows.h>
#endif

#include "inference-addon-cpp/Logger.hpp"
#include "nmt.hpp"
#include "nmt_utils.hpp"

std::string sanitizePrintableAscii(const std::string& input) {
  std::string out;
  out.reserve(input.size());
  for (char raw : input) {
    unsigned char c = static_cast<unsigned char>(raw);
    out.push_back((c >= 0x20 && c < 0x7F) ? static_cast<char>(c) : '?');
  }
  return out;
}

int get_optimal_thread_count() {
  unsigned int hw_threads = std::thread::hardware_concurrency();
  if (hw_threads == 0) {
    return 2;
  }

#ifdef __ANDROID__
  // Mobile SoCs use big.LITTLE with heterogeneous cores.  Spreading work
  // across all cores (e.g. 8 on Snapdragon 8 Elite) forces the scheduler
  // onto slow efficiency cores.  Cap at 4 to stay on performance cores;
  // empirically this matches the 2 prime + 2-3 big core layout of recent
  // Snapdragon / Exynos / Dimensity SoCs.
  const unsigned int android_max = 4;
  return static_cast<int>(std::min(hw_threads, android_max));
#endif

  if (hw_threads <= 2) {
    return hw_threads;
  } else if (hw_threads <= 16) {
    return hw_threads - 1;
  } else {
    return hw_threads - 2;
  }
}

int64_t get_time_us() {
#ifdef _WIN32
  static LARGE_INTEGER frequency = []() {
    LARGE_INTEGER freq;
    QueryPerformanceFrequency(&freq);
    return freq;
  }();
  LARGE_INTEGER counter;
  if (QueryPerformanceCounter(&counter)) {
    return (counter.QuadPart * 1000000) / frequency.QuadPart;
  }
  return GetTickCount64() * 1000;
#else
  return ggml_time_us();
#endif
}

bool ggml_graph_compute_helper(
    ggml_backend_sched_t sched, struct ggml_cgraph* graph, int n_threads,
    bool sched_reset) {
  for (int i = 0; i < ggml_backend_sched_get_n_backends(sched); ++i) {
    ggml_backend_t backend = ggml_backend_sched_get_backend(sched, i);
    ggml_backend_dev_t dev = ggml_backend_get_device(backend);
    ggml_backend_reg_t reg = dev ? ggml_backend_dev_backend_reg(dev) : nullptr;

    auto* fn_set_n_threads =
        reg ? (ggml_backend_set_n_threads_t)ggml_backend_reg_get_proc_address(
                  reg, "ggml_backend_set_n_threads")
            : nullptr;
    if (fn_set_n_threads) {
      fn_set_n_threads(backend, n_threads);
    }
  }

  const bool t =
      (ggml_backend_sched_graph_compute(sched, graph) == GGML_STATUS_SUCCESS);

  if (!t || sched_reset) {
    ggml_backend_sched_reset(sched);
  }

  return t;
}
// NOLINTEND

bool nmtNameContainsCi(const char* name, const std::string& needleLower) {
  if (name == nullptr || needleLower.empty()) {
    return false;
  }
  static constexpr size_t kMaxNameLen = 256;
  std::string nameLower(name, strnlen(name, kMaxNameLen));
  std::ranges::transform(nameLower, nameLower.begin(), [](unsigned char chr) {
    return static_cast<char>(std::tolower(chr));
  });
  return nameLower.find(needleLower) != std::string::npos;
}

namespace {
enum class NmtGpuFamily : std::uint8_t {
  None,
  Vulkan,
  Metal,
  OpenCl,
  Cuda,
  Rpc
};

bool nameHasMetalPrefix(const char* name) {
  if (name == nullptr) {
    return false;
  }
  std::string lower(name, strnlen(name, 256));
  std::ranges::transform(lower, lower.begin(), [](unsigned char chr) {
    return static_cast<char>(std::tolower(chr));
  });
  return lower.starts_with("mtl") || lower.starts_with("metal");
}

bool nameEqualsCi(const char* name, std::string_view expectedLower) {
  if (name == nullptr) {
    return false;
  }
  std::string lower(name, strnlen(name, 256));
  std::ranges::transform(lower, lower.begin(), [](unsigned char chr) {
    return static_cast<char>(std::tolower(chr));
  });
  return lower == expectedLower;
}

NmtGpuFamily
deviceFamily(const NmtBackendInterface& backend, ggml_backend_dev_t device) {
  const enum ggml_backend_dev_type type = backend.deviceType(device);
  if (type != GGML_BACKEND_DEVICE_TYPE_GPU &&
      type != GGML_BACKEND_DEVICE_TYPE_IGPU) {
    return NmtGpuFamily::None;
  }
  const char* deviceName = backend.deviceName(device);
  const ggml_backend_reg_t registry = backend.deviceRegistry(device);
  const char* registryName =
      registry != nullptr ? backend.registryName(registry) : nullptr;
  std::string normalizedDeviceName =
      deviceName == nullptr ? ""
                            : std::string(deviceName, strnlen(deviceName, 256));
  std::ranges::transform(
      normalizedDeviceName,
      normalizedDeviceName.begin(),
      [](unsigned char chr) { return static_cast<char>(std::tolower(chr)); });
  if (normalizedDeviceName.starts_with("rpc") ||
      nameEqualsCi(registryName, "rpc")) {
    return NmtGpuFamily::Rpc;
  }
  if (normalizedDeviceName.starts_with("cuda") ||
      nameEqualsCi(registryName, "cuda")) {
    return NmtGpuFamily::Cuda;
  }
  if (normalizedDeviceName == "gpuopencl" ||
      normalizedDeviceName.starts_with("opencl") ||
      nameEqualsCi(registryName, "opencl")) {
    return NmtGpuFamily::OpenCl;
  }
  if (normalizedDeviceName.starts_with("vulkan") ||
      nameEqualsCi(registryName, "vulkan")) {
    return NmtGpuFamily::Vulkan;
  }
  if (nameHasMetalPrefix(deviceName) || nameEqualsCi(registryName, "mtl") ||
      nameEqualsCi(registryName, "metal")) {
    return NmtGpuFamily::Metal;
  }
  return NmtGpuFamily::None;
}

bool matchesExplicitSelector(
    const NmtBackendInterface& backend, ggml_backend_dev_t device,
    const std::string& selectorLower) {
  if ((selectorLower == "metal" || selectorLower == "mtl") &&
      deviceFamily(backend, device) == NmtGpuFamily::Metal) {
    return true;
  }
  const ggml_backend_reg_t registry = backend.deviceRegistry(device);
  return nmtNameContainsCi(backend.deviceName(device), selectorLower) ||
         (registry != nullptr &&
          nameEqualsCi(backend.registryName(registry), selectorLower));
}
} // namespace

ggml_backend_dev_t
nmtSelectGpuDevice( // NOLINT(readability-function-cognitive-complexity)
    bool useGpu, const std::string& gpuBackend, int gpuDevice,
    const char* logPrefix) {
  const NmtBackendInterface backend{
      .deviceCount = ggml_backend_dev_count,
      .deviceGet = ggml_backend_dev_get,
      .deviceType = ggml_backend_dev_type,
      .deviceName = ggml_backend_dev_name,
      .deviceRegistry = ggml_backend_dev_backend_reg,
      .registryName = ggml_backend_reg_name,
      .deviceBufferType = ggml_backend_dev_buffer_type};
#ifdef QVAC_NMTCPP_USE_OPENCL
  constexpr bool allowDefaultOpenCl = true;
#else
  constexpr bool allowDefaultOpenCl = false;
#endif
  return nmtSelectGpuDevice(
      backend, useGpu, gpuBackend, gpuDevice, logPrefix, allowDefaultOpenCl);
}

ggml_backend_dev_t
nmtSelectGpuDevice( // NOLINT(readability-function-cognitive-complexity)
    const NmtBackendInterface& backend, bool useGpu,
    const std::string& gpuBackend, int gpuDevice, const char* logPrefix,
    bool allowDefaultOpenCl) {
  if (!useGpu) {
    return nullptr;
  }
  std::string gpuBackendLower = gpuBackend;
  std::ranges::transform(
      gpuBackendLower, gpuBackendLower.begin(), [](unsigned char chr) {
        return static_cast<char>(std::tolower(chr));
      });

  ggml_backend_dev_t dev = nullptr;
  const size_t devCount = backend.deviceCount();

  if (!gpuBackendLower.empty()) {
    // Mode 1: explicit gpu_backend filter — pick the gpuDevice-th eligible
    // device (GPU/IGPU, Vulkan/Metal/OpenCL family) whose name contains the
    // selector or whose registry name equals it; 'metal'/'mtl' also match
    // any Metal-family device.
    bool deviceFoundButBuftNull = false;
    int cnt = 0;
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t devCur = backend.deviceGet(i);
      if (devCur == nullptr) {
        continue;
      }
      const char* name = backend.deviceName(devCur);
      if (deviceFamily(backend, devCur) == NmtGpuFamily::None) {
        continue;
      }
      if (!matchesExplicitSelector(backend, devCur, gpuBackendLower)) {
        continue;
      }
      if (cnt == gpuDevice) {
        ggml_backend_buffer_type_t buft = backend.deviceBufferType(devCur);
        if (buft != nullptr) {
          dev = devCur;
          std::ostringstream oss;
          oss << "[" << logPrefix << "] SELECTED explicit gpu_backend='"
              << gpuBackend << "': " << (name != nullptr ? name : "(null)");
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
        } else {
          deviceFoundButBuftNull = true;
          std::ostringstream oss;
          oss << "[" << logPrefix
              << "] gpu_backend matched device but buffer type is null — "
                 "skipping";
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
              oss.str());
        }
      }
      if (++cnt > gpuDevice) {
        break;
      }
    }
#ifndef QVAC_NMTCPP_USE_OPENCL
    // OpenCL is opt-in via any explicit selector that resolves to an OpenCL
    // device even when the build-time guard is off. Warn loudly because the
    // guard exists specifically to mitigate the Adreno 830 q4_0 transpose
    // abort (QVAC-17790); callers bypassing it must accept the risk.
    if (dev != nullptr && deviceFamily(backend, dev) == NmtGpuFamily::OpenCl) {
      std::ostringstream oss;
      oss << "[" << logPrefix << "] Explicit gpu_backend='" << gpuBackend
          << "' selected OpenCL while QVAC_NMTCPP_USE_OPENCL=OFF — Adreno 830 "
             "devices may still abort with GGML_ASSERT(M % 4 == 0). Caller "
             "assumes risk.";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
#endif
    if (dev == nullptr) {
      std::ostringstream oss;
      if (deviceFoundButBuftNull) {
        oss << "[" << logPrefix << "] Explicit gpu_backend='" << gpuBackend
            << "' matched a device but its buffer type was null (unusable) "
               "— falling back to CPU";
      } else {
        oss << "[" << logPrefix << "] Explicit gpu_backend='" << gpuBackend
            << "' matched no eligible registered device — falling back to "
               "CPU";
      }
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
    return dev;
  }

  // Mode 2: gated default.
  // Mode 2a: prefer OpenCL.
  bool oclDeviceFoundButBuftNull = false;
  if (allowDefaultOpenCl) {
    int cnt = 0;
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t devCur = backend.deviceGet(i);
      if (devCur == nullptr) {
        continue;
      }
      const char* name = backend.deviceName(devCur);
      if (deviceFamily(backend, devCur) != NmtGpuFamily::OpenCl) {
        continue;
      }
      if (cnt == gpuDevice) {
        ggml_backend_buffer_type_t buft = backend.deviceBufferType(devCur);
        if (buft != nullptr) {
          dev = devCur;
          std::ostringstream oss;
          oss << "[" << logPrefix << "] SELECTED OpenCL backend: "
              << (name != nullptr ? name : "(null)");
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
        } else {
          oclDeviceFoundButBuftNull = true;
          std::ostringstream oss;
          oss << "[" << logPrefix
              << "] OpenCL device matched but buffer type is null — "
                 "skipping to Mode 2b fallback";
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
              oss.str());
        }
      }
      if (++cnt > gpuDevice) {
        break;
      }
    }
  }

  // Mode 2b: resolve gpuDevice within the eligible non-OpenCL inventory.
  // OpenCL is always skipped here because Mode 2a already handles it when
  // QVAC_NMTCPP_USE_OPENCL is defined, and it's unwanted when the guard is
  // off. This ensures gpuDevice ordinals map to distinct physical GPUs without
  // OpenCL duplicates or unsupported families occupying slots.
  if (dev == nullptr) {
    if (allowDefaultOpenCl && oclDeviceFoundButBuftNull) {
      std::ostringstream oss;
      oss << "[" << logPrefix
          << "] Mode 2a OpenCL device found but buffer type was null — "
             "falling through to Mode 2b";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
    const int fallbackOrdinal = gpuDevice;
    int cnt2 = 0;
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t devCur = backend.deviceGet(i);
      if (devCur == nullptr) {
        continue;
      }
      const char* name = backend.deviceName(devCur);
      const NmtGpuFamily family = deviceFamily(backend, devCur);
      if (family == NmtGpuFamily::None || family == NmtGpuFamily::OpenCl) {
        continue;
      }
      if (cnt2 == fallbackOrdinal) {
        if (ggml_backend_buffer_type_t buft = backend.deviceBufferType(devCur);
            buft != nullptr) {
          dev = devCur;
          std::ostringstream oss;
          oss << "[" << logPrefix << "] SELECTED compute backend: "
              << (name != nullptr ? name : "(null)");
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
        } else {
          std::ostringstream oss;
          oss << "[" << logPrefix
              << "] Compute device matched but buffer type is null — "
                 "skipping";
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
              oss.str());
        }
      }
      if (++cnt2 > fallbackOrdinal) {
        break;
      }
    }
  }

  return dev;
}

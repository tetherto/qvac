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
#include <vector>

#include <ggml-backend.h>
#include <ggml.h>

#ifdef _WIN32
#include <windows.h>
#endif

#include "inference-addon-cpp/Logger.hpp"
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
enum class NmtGpuFamily : std::uint8_t { None, Vulkan, Metal, OpenCl, Cuda };

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
  // Translation runs a single compute device, which RPC cannot serve.
  if (normalizedDeviceName.starts_with("rpc") ||
      nameEqualsCi(registryName, "rpc")) {
    return NmtGpuFamily::None;
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

// "name (registry)" identity used in CPU-fallback logs so operators can trace
// which GPU-type devices the family allowlist refused. Empty inputs collapse to
// `unnamed` / `unknown-registry` so the string is never blank.
std::string
deviceIdentity(const NmtBackendInterface& backend, ggml_backend_dev_t device) {
  const char* namePtr = backend.deviceName(device);
  const ggml_backend_reg_t registry = backend.deviceRegistry(device);
  const char* regPtr =
      registry != nullptr ? backend.registryName(registry) : nullptr;
  const std::string name = namePtr != nullptr ? namePtr : "unnamed";
  const std::string reg = regPtr != nullptr ? regPtr : "unknown-registry";
  return name + " (" + reg + ")";
}

// GPU/IGPU-type registry slots whose family is refused by the allowlist
// (HIP/ROCm, SYCL, MUSA, RPC, unknown). Presented in the CPU-fallback log so
// callers see whether their unusable request would have succeeded on a
// different backend family.
std::vector<std::string>
refusedGpuIdentities(const NmtBackendInterface& backend) {
  std::vector<std::string> refused;
  const size_t devCount = backend.deviceCount();
  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t devCur = backend.deviceGet(i);
    if (devCur == nullptr) {
      continue;
    }
    const enum ggml_backend_dev_type type = backend.deviceType(devCur);
    if ((type == GGML_BACKEND_DEVICE_TYPE_GPU ||
         type == GGML_BACKEND_DEVICE_TYPE_IGPU) &&
        deviceFamily(backend, devCur) == NmtGpuFamily::None) {
      refused.push_back(deviceIdentity(backend, devCur));
    }
  }
  return refused;
}

// Eligible devices in selection order: dedicated GPUs first, then integrated
// ones, registry order preserved within each class.
std::vector<ggml_backend_dev_t>
eligibleDevices(const NmtBackendInterface& backend) {
  std::vector<ggml_backend_dev_t> dedicated;
  std::vector<ggml_backend_dev_t> integrated;
  const size_t devCount = backend.deviceCount();
  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t devCur = backend.deviceGet(i);
    if (devCur == nullptr ||
        deviceFamily(backend, devCur) == NmtGpuFamily::None) {
      continue;
    }
    if (backend.deviceType(devCur) == GGML_BACKEND_DEVICE_TYPE_IGPU) {
      integrated.push_back(devCur);
    } else {
      dedicated.push_back(devCur);
    }
  }
  dedicated.insert(dedicated.end(), integrated.begin(), integrated.end());
  return dedicated;
}

// The `ordinal`-th accepted device, or nullptr when it is missing or its
// buffer type is null (which sets `bufferTypeWasNull`).
template <typename Accept>
ggml_backend_dev_t selectNth(
    const NmtBackendInterface& backend,
    const std::vector<ggml_backend_dev_t>& eligible, Accept accept, int ordinal,
    bool& bufferTypeWasNull) {
  int cnt = 0;
  for (ggml_backend_dev_t devCur : eligible) {
    if (!accept(devCur)) {
      continue;
    }
    if (cnt == ordinal) {
      if (backend.deviceBufferType(devCur) != nullptr) {
        return devCur;
      }
      bufferTypeWasNull = true;
      return nullptr;
    }
    ++cnt;
  }
  return nullptr;
}
} // namespace

ggml_backend_dev_t
nmtSelectGpuDevice( // NOLINT(readability-function-cognitive-complexity)
    bool useGpu, const std::string& gpuBackend, int gpuDevice,
    const char* logPrefix, const NmtMainGpu& mainGpu, bool legacyGpuSelection) {
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
      backend,
      useGpu,
      gpuBackend,
      gpuDevice,
      logPrefix,
      allowDefaultOpenCl,
      mainGpu,
      legacyGpuSelection);
}

ggml_backend_dev_t
nmtSelectGpuDevice( // NOLINT(readability-function-cognitive-complexity)
    const NmtBackendInterface& backend, bool useGpu,
    const std::string& gpuBackend, int gpuDevice, const char* logPrefix,
    bool allowDefaultOpenCl, const NmtMainGpu& mainGpu,
    bool legacyGpuSelection) {
  if (!useGpu) {
    return nullptr;
  }
  if (const auto* index = std::get_if<int64_t>(&mainGpu)) {
    if (*index >= 0 && static_cast<uint64_t>(*index) < backend.deviceCount()) {
      const auto target = backend.deviceGet(static_cast<size_t>(*index));
      // Resolve before eligibility filtering: an unsupported raw index must
      // never silently select a different GPU after inventory compaction.
      if (target != nullptr) {
        const auto family = deviceFamily(backend, target);
        if (family != NmtGpuFamily::None &&
            (allowDefaultOpenCl || family != NmtGpuFamily::OpenCl) &&
            backend.deviceBufferType(target) != nullptr) {
          return target;
        }
      }
      const std::string identity =
          target != nullptr ? deviceIdentity(backend, target) : "null-device";
      std::ostringstream oss;
      oss << "main-gpu registry device " << identity
          << " is ineligible; falling back to CPU";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
      return nullptr;
    }
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "main-gpu registry index is out of range; using automatic selection");
  }
  const bool hasMainGpu = !std::holds_alternative<std::monostate>(mainGpu);
  // A canonical selector must not inherit a stale legacy filter from an
  // earlier model configuration or a direct legacy setter call.
  if (hasMainGpu) {
    legacyGpuSelection = false;
    gpuDevice = 0;
  }
  std::string gpuBackendLower = hasMainGpu ? "" : gpuBackend;
  std::ranges::transform(
      gpuBackendLower, gpuBackendLower.begin(), [](unsigned char chr) {
        return static_cast<char>(std::tolower(chr));
      });

  ggml_backend_dev_t dev = nullptr;
  std::vector<ggml_backend_dev_t> eligible = eligibleDevices(backend);

  if (const auto* preference = std::get_if<std::string>(&mainGpu)) {
    const auto wanted = *preference == "integrated"
                            ? GGML_BACKEND_DEVICE_TYPE_IGPU
                            : GGML_BACKEND_DEVICE_TYPE_GPU;
    std::erase_if(eligible, [&](ggml_backend_dev_t device) {
      return backend.deviceType(device) != wanted;
    });
  }

  if (!gpuBackendLower.empty()) {
    // Mode 1: explicit gpu_backend filter — the gpuDevice-th eligible device
    // whose name contains the selector or whose registry name equals it.
    bool deviceFoundButBuftNull = false;
    dev = selectNth(
        backend,
        eligible,
        [&](ggml_backend_dev_t devCur) {
          return matchesExplicitSelector(backend, devCur, gpuBackendLower);
        },
        gpuDevice,
        deviceFoundButBuftNull);
    if (dev != nullptr) {
      const char* name = backend.deviceName(dev);
      std::ostringstream oss;
      oss << "[" << logPrefix << "] SELECTED explicit gpu_backend='"
          << gpuBackend << "': " << (name != nullptr ? name : "(null)");
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
    } else if (deviceFoundButBuftNull) {
      std::ostringstream oss;
      oss << "[" << logPrefix
          << "] gpu_backend matched device but buffer type is null — "
             "skipping";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
#ifndef QVAC_NMTCPP_USE_OPENCL
    // An explicit selector may opt into OpenCL past the build guard, which
    // exists to avoid the Adreno 830 q4_0 transpose abort (QVAC-17790).
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

  // Automatic selection prefers a dedicated GPU across backend families.
  // Explicit legacy ordinals retain the historical OpenCL-first inventory.
  if (!legacyGpuSelection) {
    for (const auto type :
         {GGML_BACKEND_DEVICE_TYPE_GPU, GGML_BACKEND_DEVICE_TYPE_IGPU}) {
      for (const bool openClPass : {true, false}) {
        if (openClPass && !allowDefaultOpenCl) {
          continue;
        }
        for (const auto candidate : eligible) {
          if (backend.deviceType(candidate) == type &&
              (deviceFamily(backend, candidate) == NmtGpuFamily::OpenCl) ==
                  openClPass &&
              backend.deviceBufferType(candidate) != nullptr) {
            return candidate;
          }
        }
      }
    }
    const auto refused = refusedGpuIdentities(backend);
    if (!refused.empty()) {
      std::ostringstream oss;
      oss << "[" << logPrefix
          << "] GPU execution requested but no eligible device is available; "
             "falling back to CPU. Refused GPU-type devices:";
      for (const auto& identity : refused) {
        oss << " [" << identity << "]";
      }
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
    return nullptr;
  }

  // Mode 2: gated default.
  // Mode 2a: prefer OpenCL.
  bool oclDeviceFoundButBuftNull = false;
  if (allowDefaultOpenCl) {
    dev = selectNth(
        backend,
        eligible,
        [&](ggml_backend_dev_t devCur) {
          return deviceFamily(backend, devCur) == NmtGpuFamily::OpenCl;
        },
        gpuDevice,
        oclDeviceFoundButBuftNull);
    if (dev != nullptr) {
      const char* name = backend.deviceName(dev);
      std::ostringstream oss;
      oss << "[" << logPrefix << "] SELECTED OpenCL backend: "
          << (name != nullptr ? name : "(null)");
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
    } else if (oclDeviceFoundButBuftNull) {
      std::ostringstream oss;
      oss << "[" << logPrefix
          << "] OpenCL device matched but buffer type is null — "
             "skipping to Mode 2b fallback";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
  }

  // Mode 2b: resolve gpuDevice within the eligible non-OpenCL inventory, so
  // ordinals map to distinct physical GPUs without OpenCL duplicates.
  if (dev == nullptr) {
    if (allowDefaultOpenCl && oclDeviceFoundButBuftNull) {
      std::ostringstream oss;
      oss << "[" << logPrefix
          << "] Mode 2a OpenCL device found but buffer type was null — "
             "falling through to Mode 2b";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
    bool fallbackFoundButBuftNull = false;
    dev = selectNth(
        backend,
        eligible,
        [&](ggml_backend_dev_t devCur) {
          return deviceFamily(backend, devCur) != NmtGpuFamily::OpenCl;
        },
        gpuDevice,
        fallbackFoundButBuftNull);
    if (dev != nullptr) {
      const char* name = backend.deviceName(dev);
      std::ostringstream oss;
      oss << "[" << logPrefix << "] SELECTED compute backend: "
          << (name != nullptr ? name : "(null)");
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
    } else if (fallbackFoundButBuftNull) {
      std::ostringstream oss;
      oss << "[" << logPrefix
          << "] Compute device matched but buffer type is null — skipping";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
  }

  return dev;
}

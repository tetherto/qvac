// NOLINTBEGIN
#include <algorithm>
#include <cctype>
#include <cstring>
#include <ranges>
#include <sstream>
#include <string>
#include <thread>

#include <ggml-backend.h>
#include <ggml.h>

#ifdef _WIN32
#include <windows.h>
#endif

#include "nmt.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

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
    bool sched_reset = true) {
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

ggml_backend_dev_t
nmtSelectGpuDevice( // NOLINT(readability-function-cognitive-complexity)
    bool useGpu, const std::string& gpuBackend, int gpuDevice,
    const char* logPrefix) {
  if (!useGpu) {
    return nullptr;
  }
  std::string gpuBackendLower = gpuBackend;
  std::ranges::transform(
      gpuBackendLower, gpuBackendLower.begin(), [](unsigned char chr) {
        return static_cast<char>(std::tolower(chr));
      });

  ggml_backend_dev_t dev = nullptr;
  const size_t devCount = ggml_backend_dev_count();

  if (!gpuBackendLower.empty()) {
#ifndef QVAC_NMTCPP_USE_OPENCL
    // OpenCL is opt-in via explicit gpu_backend even when the build-time
    // guard is off. Warn loudly because the guard exists specifically to
    // mitigate the Adreno 830 q4_0 transpose abort (QVAC-17790); callers
    // bypassing it must accept the risk.
    if (gpuBackendLower.find("opencl") != std::string::npos) {
      std::ostringstream oss;
      oss << "[" << logPrefix
          << "] Explicit gpu_backend='opencl' bypasses the "
             "QVAC_NMTCPP_USE_OPENCL=OFF guard — Adreno 830 devices may still "
             "abort with GGML_ASSERT(M % 4 == 0). Caller assumes risk.";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
#endif
    // Mode 1: explicit gpu_backend filter — pick the gpuDevice-th matching
    // non-CPU device whose name contains the substring.
    bool deviceFoundButBuftNull = false;
    int cnt = 0;
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t devCur = ggml_backend_dev_get(i);
      if (devCur == nullptr) {
        continue;
      }
      enum ggml_backend_dev_type devType = ggml_backend_dev_type(devCur);
      const char* name = ggml_backend_dev_name(devCur);
      if (devType == GGML_BACKEND_DEVICE_TYPE_CPU) {
        continue;
      }
      if (!nmtNameContainsCi(name, gpuBackendLower)) {
        continue;
      }
      if (cnt == gpuDevice) {
        ggml_backend_buffer_type_t buft = ggml_backend_dev_buffer_type(devCur);
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
    if (dev == nullptr) {
      std::ostringstream oss;
      if (deviceFoundButBuftNull) {
        oss << "[" << logPrefix << "] Explicit gpu_backend='" << gpuBackend
            << "' matched a device but its buffer type was null (unusable) "
               "— falling back to CPU";
      } else {
        oss << "[" << logPrefix << "] Explicit gpu_backend='" << gpuBackend
            << "' matched no registered device — falling back to CPU";
      }
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
    return dev;
  }

  // Mode 2: gated default.
#ifdef QVAC_NMTCPP_USE_OPENCL
  // Mode 2a: prefer OpenCL.
  bool oclDeviceFoundButBuftNull = false;
  {
    int cnt = 0;
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t devCur = ggml_backend_dev_get(i);
      if (devCur == nullptr) {
        continue;
      }
      enum ggml_backend_dev_type devType = ggml_backend_dev_type(devCur);
      const char* name = ggml_backend_dev_name(devCur);
      if (devType == GGML_BACKEND_DEVICE_TYPE_CPU) {
        continue;
      }
      if (!nmtNameContainsCi(name, "opencl")) {
        continue;
      }
      if (cnt == gpuDevice) {
        ggml_backend_buffer_type_t buft = ggml_backend_dev_buffer_type(devCur);
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
#endif

  // Mode 2b: fallback to any non-CPU, non-OpenCL compute device.
  // OpenCL is always skipped here because Mode 2a already handles it when
  // QVAC_NMTCPP_USE_OPENCL is defined, and it's unwanted when the guard is
  // off. This ensures gpuDevice ordinals map to distinct physical GPUs
  // (Vulkan/CUDA/Metal) without OpenCL duplicates occupying slots.
  if (dev == nullptr) {
#ifdef QVAC_NMTCPP_USE_OPENCL
    if (oclDeviceFoundButBuftNull) {
      std::ostringstream oss;
      oss << "[" << logPrefix
          << "] Mode 2a OpenCL device found but buffer type was null — "
             "falling through to Mode 2b";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
#endif
    const int fallbackOrdinal = gpuDevice;
    int cnt2 = 0;
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t devCur = ggml_backend_dev_get(i);
      if (devCur == nullptr) {
        continue;
      }
      enum ggml_backend_dev_type devType = ggml_backend_dev_type(devCur);
      const char* name = ggml_backend_dev_name(devCur);
      if (devType == GGML_BACKEND_DEVICE_TYPE_CPU) {
        continue;
      }
      if (nmtNameContainsCi(name, "opencl")) {
        continue;
      }
      if (cnt2 == fallbackOrdinal) {
        ggml_backend_buffer_type_t buft = ggml_backend_dev_buffer_type(devCur);
        if (buft != nullptr) {
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

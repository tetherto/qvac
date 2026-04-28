// NOLINTBEGIN
#include <algorithm>
#include <cctype>
#include <cstring>
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

// Get optimal number of threads for computation
// Optimized for GitHub runners (typically 2 CPUs) and other environments
int get_optimal_thread_count() {
  unsigned int hw_threads = std::thread::hardware_concurrency();
  if (hw_threads == 0) {
    // Fallback if hardware_concurrency() fails
    return 2;
  }
  // For GitHub runners (typically 2 CPUs), use both cores
  // For machines with more cores, use most but leave 1-2 for system
  if (hw_threads <= 2) {
    return hw_threads; // Use all available cores
  } else if (hw_threads <= 16) {
    return hw_threads - 1; // Leave 1 core
  } else {
    return hw_threads - 2; // Leave 2 cores for system on high-core machines
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
        (ggml_backend_set_n_threads_t)ggml_backend_reg_get_proc_address(
            reg, "ggml_backend_set_n_threads");
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

bool nmt_name_contains_ci(const char* name, const std::string& needle_lower) {
  if (name == nullptr || needle_lower.empty()) {
    return false;
  }
  // Defensive bound: ggml device names should be NUL-terminated, but a
  // misbehaving / adversarial backend .so could violate that. Cap the scan
  // length so the inner loop can't read past the end of a malformed buffer.
  static constexpr size_t kMaxNameLen = 256;
  const size_t name_len = strnlen(name, kMaxNameLen);
  const char* const name_end = name + name_len;
  const char* const needle = needle_lower.c_str();
  for (const char* p = name; p < name_end; ++p) {
    const char* s = p;
    const char* n = needle;
    while (s < name_end && *n != '\0' &&
           static_cast<char>(std::tolower(static_cast<unsigned char>(*s))) ==
               *n) {
      ++s;
      ++n;
    }
    if (*n == '\0') {
      return true;
    }
  }
  return false;
}

ggml_backend_dev_t nmt_select_gpu_device(
    bool use_gpu, const std::string& gpu_backend, int gpu_device,
    const char* log_prefix) {
  if (!use_gpu) {
    return nullptr;
  }
  std::string gpuBackendLower = gpu_backend;
  std::transform(
      gpuBackendLower.begin(),
      gpuBackendLower.end(),
      gpuBackendLower.begin(),
      [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

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
      oss << "[" << log_prefix
          << "] Explicit gpu_backend='opencl' bypasses the "
             "QVAC_NMTCPP_USE_OPENCL=OFF guard — Adreno 830 devices may still "
             "abort with GGML_ASSERT(M % 4 == 0). Caller assumes risk.";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
#endif
    // Mode 1: explicit gpu_backend filter — pick the gpu_device-th matching
    // non-CPU device whose name contains the substring.
    bool deviceFoundButBuftNull = false;
    int cnt = 0;
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t dev_cur = ggml_backend_dev_get(i);
      if (dev_cur == nullptr) {
        continue;
      }
      enum ggml_backend_dev_type dev_type = ggml_backend_dev_type(dev_cur);
      const char* name = ggml_backend_dev_name(dev_cur);
      if (dev_type == GGML_BACKEND_DEVICE_TYPE_CPU) {
        continue;
      }
      if (!nmt_name_contains_ci(name, gpuBackendLower)) {
        continue;
      }
      if (cnt == gpu_device) {
        ggml_backend_buffer_type_t buft = ggml_backend_dev_buffer_type(dev_cur);
        if (buft != nullptr) {
          dev = dev_cur;
          std::ostringstream oss;
          oss << "[" << log_prefix << "] SELECTED explicit gpu_backend='"
              << gpu_backend << "': " << (name ? name : "(null)");
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
        } else {
          deviceFoundButBuftNull = true;
          std::ostringstream oss;
          oss << "[" << log_prefix
              << "] gpu_backend matched device but buffer type is null — "
                 "skipping";
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
              oss.str());
        }
      }
      if (++cnt > gpu_device) {
        break;
      }
    }
    if (dev == nullptr) {
      std::ostringstream oss;
      if (deviceFoundButBuftNull) {
        oss << "[" << log_prefix << "] Explicit gpu_backend='" << gpu_backend
            << "' matched a device but its buffer type was null (unusable) "
               "— falling back to CPU";
      } else {
        oss << "[" << log_prefix << "] Explicit gpu_backend='" << gpu_backend
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
      ggml_backend_dev_t dev_cur = ggml_backend_dev_get(i);
      if (dev_cur == nullptr) {
        continue;
      }
      enum ggml_backend_dev_type dev_type = ggml_backend_dev_type(dev_cur);
      const char* name = ggml_backend_dev_name(dev_cur);
      if (dev_type == GGML_BACKEND_DEVICE_TYPE_CPU) {
        continue;
      }
      if (!nmt_name_contains_ci(name, "opencl")) {
        continue;
      }
      if (cnt == gpu_device) {
        ggml_backend_buffer_type_t buft = ggml_backend_dev_buffer_type(dev_cur);
        if (buft != nullptr) {
          dev = dev_cur;
          std::ostringstream oss;
          oss << "[" << log_prefix
              << "] SELECTED OpenCL backend: " << (name ? name : "(null)");
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
        } else {
          oclDeviceFoundButBuftNull = true;
          std::ostringstream oss;
          oss << "[" << log_prefix
              << "] OpenCL device matched but buffer type is null — "
                 "skipping to Mode 2b fallback";
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
              oss.str());
        }
      }
      if (++cnt > gpu_device) {
        break;
      }
    }
  }
#endif

  // Mode 2b: fallback to any non-CPU compute device (skipping OpenCL when
  // the build-time guard is off — Adreno 830 mitigation).
  // When falling through from Mode 2a (OpenCL preference didn't find enough
  // devices), reset the ordinal to 0 — the caller's gpu_device referred to
  // the OpenCL device namespace, not the full device list.
  if (dev == nullptr) {
#ifdef QVAC_NMTCPP_USE_OPENCL
    if (oclDeviceFoundButBuftNull) {
      std::ostringstream oss;
      oss << "[" << log_prefix
          << "] Mode 2a OpenCL device found but buffer type was null — "
             "falling through to Mode 2b with ordinal 0";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, oss.str());
    }
#endif
    const int fallback_ordinal =
#ifdef QVAC_NMTCPP_USE_OPENCL
        0;
#else
        gpu_device;
#endif
    int cnt2 = 0;
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t dev_cur = ggml_backend_dev_get(i);
      if (dev_cur == nullptr) {
        continue;
      }
      enum ggml_backend_dev_type dev_type = ggml_backend_dev_type(dev_cur);
      const char* name = ggml_backend_dev_name(dev_cur);
      if (dev_type == GGML_BACKEND_DEVICE_TYPE_CPU) {
        continue;
      }
#ifndef QVAC_NMTCPP_USE_OPENCL
      if (nmt_name_contains_ci(name, "opencl")) {
        continue;
      }
#endif
      if (cnt2 == fallback_ordinal) {
        ggml_backend_buffer_type_t buft = ggml_backend_dev_buffer_type(dev_cur);
        if (buft != nullptr) {
          dev = dev_cur;
          std::ostringstream oss;
          oss << "[" << log_prefix
              << "] SELECTED compute backend: " << (name ? name : "(null)");
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
        } else {
          std::ostringstream oss;
          oss << "[" << log_prefix
              << "] Compute device matched but buffer type is null — "
                 "skipping";
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
              oss.str());
        }
      }
      if (++cnt2 > fallback_ordinal) {
        break;
      }
    }
  }

  return dev;
}

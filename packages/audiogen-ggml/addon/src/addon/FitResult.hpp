#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include <audiogen-cpp/acestep/fit.h>
#include <ggml-backend.h>
#include <inference-addon-cpp/Errors.hpp>

namespace qvac::audiogenggml::addon_js {

struct FitDevice {
  std::string id;
  std::string name;
  bool unified;
  double usedBytes;
  double freeBytes;
  double totalBytes;
};

struct FitResult {
  std::string status;
  std::vector<FitDevice> devices;
};

// The PCI bus ID when the backend reports one, so the same GPU matches across
// addons built on different backends; the device name otherwise.
//
// Unified marks memory the host owns: the CPU, an integrated GPU, a GPU that
// shares host memory, Android's OpenCL GPU, and a device that reports no
// memory of its own. A unified device that reports none takes the CPU's
// figures.
inline FitDevice fitDevice(
    ggml_backend_dev_t device, const std::string& name, bool sharesHostMemory,
    uint64_t usedBytes, uint64_t freeBytes, uint64_t totalBytes) {
  std::string id = name;
  std::string deviceName = name;
  const bool reportsNoMemory = totalBytes == 0;
  bool unified = sharesHostMemory || reportsNoMemory;
  if (device != nullptr) {
    ggml_backend_dev_props props{};
    ggml_backend_dev_get_props(device, &props);
    id = props.device_id != nullptr ? props.device_id : props.name;
    deviceName = props.name;
    unified = unified || props.memory_unified ||
              props.type == GGML_BACKEND_DEVICE_TYPE_IGPU ||
              props.type == GGML_BACKEND_DEVICE_TYPE_CPU;
#if defined(__ANDROID__)
    const char* registry =
        ggml_backend_reg_name(ggml_backend_dev_backend_reg(device));
    unified = unified ||
              (registry != nullptr && std::strcmp(registry, "OpenCL") == 0);
#endif
  }
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
      id,
      deviceName,
      unified,
      static_cast<double>(usedBytes),
      static_cast<double>(freeBytes),
      static_cast<double>(totalBytes)};
}

// A load the fitter could not measure would still start, so it is unknown:
// MiniMax with Core ML stages, which have no memory estimate, and a failed
// measurement. A request or model file the fitter refuses rejects as an
// invalid argument, and any other failure as an internal one.
inline FitResult unsizedOrThrow(const std::string& reason) {
  if (reason == "coreml-memory-estimate-unavailable" ||
      reason == "measurement-failed") {
    return FitResult{"unknown", {}};
  }
  const bool invalid = reason == "invalid-arguments" ||
                       reason == "workload-too-large" ||
                       reason == "model-unreadable";
  throw qvac_errors::StatusError(
      invalid ? qvac_errors::general_error::InvalidArgument
              : qvac_errors::general_error::InternalError,
      "assessFit: " + reason);
}

inline void
appendExtraDevices(FitResult& result, const tts_cpp::acestep::FitResult& fit) {
  for (const auto& pool : fit.extra_devices) {
    result.devices.push_back(fitDevice(
        ggml_backend_dev_by_name(pool.name.c_str()),
        pool.name,
        pool.shares_host_memory,
        pool.peak_bytes,
        pool.free_bytes,
        pool.total_bytes));
  }
}

// One row per device pool the pipeline peaks on, then the host CPU, which holds
// the CPU-placed stages, the mapped weights and the host-side buffers. Each
// figure is that pool's peak across the pipeline's phases. On the CPU the
// device pool is the host pool and both peaks measure it, so a load there is
// one row carrying that peak once.
inline FitResult toFitResult(const tts_cpp::acestep::FitResult& fit) {
  if (fit.status == tts_cpp::acestep::FitStatus::Error) {
    return unsizedOrThrow(fit.reason);
  }

  FitResult result;
  result.status = fit.status == tts_cpp::acestep::FitStatus::Success
                      ? "fits"
                      : "does-not-fit";

  ggml_backend_dev_t host =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (!fit.device_is_cpu) {
    result.devices.push_back(fitDevice(
        ggml_backend_dev_by_name(fit.device_name.c_str()),
        fit.device_name,
        fit.device_shares_host_memory,
        fit.peak_device_bytes,
        fit.device_free_bytes,
        fit.device_total_bytes));
  }
  appendExtraDevices(result, fit);
  result.devices.push_back(fitDevice(
      host,
      "CPU",
      true,
      fit.device_is_cpu ? std::max(fit.peak_device_bytes, fit.peak_host_bytes)
                        : fit.peak_host_bytes,
      fit.host_free_bytes,
      fit.host_total_bytes));
  return result;
}

} // namespace qvac::audiogenggml::addon_js

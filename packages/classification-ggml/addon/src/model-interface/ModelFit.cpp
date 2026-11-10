#include "ModelFit.hpp"

#include <cstring>
#include <initializer_list>
#include <utility>

#include "GgmlBackend.hpp"
#include "ModelFootprint.hpp"

#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
#include <os/proc.h>
#endif
#endif

#include <ggml-backend.h>
#include <inference-addon-cpp/Errors.hpp>

namespace classification_ggml::fit {
namespace {

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

uint64_t checkedSum(std::initializer_list<uint64_t> terms) {
  uint64_t total = 0;
  for (const uint64_t term : terms) {
    if (term > MAX_JS_SAFE_INTEGER - total)
      throw StatusError(
          InvalidArgument, "assessFit: the footprint overflows a safe integer");
    total += term;
  }
  return total;
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

FitResult assessModelFit(
    const std::string& path, const std::string& backend,
    const std::string& backendsDir, int width, int height, int threads,
    uint64_t marginBytes) {
  // The measurement registers the backends and selects the device the same
  // way a load does, under backendRegistryMutex. ggml keeps registered
  // backends for the process lifetime, so the device can be looked up by name
  // once the measurement has returned.
  const ModelFootprint footprint =
      measureFootprint(path, backend, backendsDir, width, height, threads);
  const uint64_t hostBytes = checkedSum(
      {footprint.hostWeightBytes,
       footprint.hostComputeBytes,
       footprint.hostWorkBytes,
       footprint.hostStagingBytes});

  // The selected device first, then the host CPU. A CPU load is one row that
  // carries every host term. A verdict always carries the host row, so a
  // registry without a CPU device to name it by leaves the load unsized.
  FitResult result;
  const std::lock_guard<std::mutex> lock(backendRegistryMutex());
  ggml_backend_dev_t host =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (host == nullptr)
    return result;
  std::vector<FitDevice> rows;
  if (!footprint.deviceIsCpu) {
    ggml_backend_dev_t device =
        ggml_backend_dev_by_name(footprint.deviceName.c_str());
    if (device == nullptr)
      return result;
    rows.push_back(fitDevice(
        device,
        checkedSum(
            {footprint.deviceWeightBytes, footprint.deviceComputeBytes})));
  }
  rows.push_back(fitDevice(host, hostBytes));
  for (const FitDevice& row : rows) {
    if (row.freeBytes == 0 || row.freeBytes > MAX_JS_SAFE_INTEGER ||
        row.totalBytes > MAX_JS_SAFE_INTEGER) {
      return result;
    }
  }

#if defined(__APPLE__) && TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
  capToAppLimit(rows, static_cast<uint64_t>(os_proc_available_memory()));
#endif

  result.status = fitVerdict(rows, marginBytes);
  result.devices = std::move(rows);
  return result;
}

} // namespace classification_ggml::fit

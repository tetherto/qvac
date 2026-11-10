#include "GgmlBackend.hpp"

#include <inference-addon-cpp/Errors.hpp>
#include <qvac-fabric.h>

namespace classification_ggml {

using qvac_errors::StatusError;
using qvac_errors::general_error::InternalError;
using qvac_errors::general_error::InvalidArgument;

int backendId(const char* name) {
  const std::string value(name);
  if (value.starts_with("CPU"))
    return 0;
  if (value.starts_with("Metal") || value.starts_with("MTL"))
    return 1;
  if (value.starts_with("CUDA"))
    return 2;
  if (value.starts_with("Vulkan"))
    return 3;
  if (value.starts_with("OpenCL") || value.starts_with("GPUOpenCL"))
    return 4;
  return 99;
}

GgmlBackends::GgmlBackends(
    const std::string& backend, const std::string& backendsDir, int threads,
    const std::string& who) {
#if defined(GGML_BACKEND_DL)
  if (backendsDir.empty())
    qvac_fabric_load_backends();
  else
    ggml_backend_load_all_from_path(backendsDir.c_str());
#else
  (void)backendsDir;
#endif
  auto* selected = backend.empty()
                       ? ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU)
                       : ggml_backend_dev_by_name(backend.c_str());
  if (!selected && backend.starts_with("Metal")) {
    const auto name = "MTL" + backend.substr(5);
    selected = ggml_backend_dev_by_name(name == "MTL" ? "MTL0" : name.c_str());
  }
  if (!selected && backend.empty())
    selected = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_IGPU);
  if (!selected && backend.empty())
    selected = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (selected == nullptr)
    throw StatusError(
        InvalidArgument,
        who + ": requested backend is unavailable: " + backend);
  device_ = ggml_backend_dev_init(selected, nullptr);
  if (!device_)
    throw StatusError(InternalError, who + " backend initialization failed");
  cpu_ = ggml_backend_dev_type(selected) == GGML_BACKEND_DEVICE_TYPE_CPU
             ? device_
             : ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  if (!cpu_) {
    ggml_backend_free(device_);
    device_ = nullptr;
    throw StatusError(
        InternalError, who + " CPU backend initialization failed");
  }
  auto* registry = ggml_backend_dev_backend_reg(ggml_backend_get_device(cpu_));
  auto setThreads = reinterpret_cast<void (*)(ggml_backend_t, int)>(
      ggml_backend_reg_get_proc_address(
          registry, "ggml_backend_set_n_threads"));
  if (setThreads)
    setThreads(cpu_, threads);
}

GgmlBackends::~GgmlBackends() {
  if (cpu_ && cpu_ != device_)
    ggml_backend_free(cpu_);
  if (device_)
    ggml_backend_free(device_);
}

} // namespace classification_ggml

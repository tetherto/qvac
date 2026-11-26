#pragma once

#include <map>
#include <string>
#include <vector>

#include <ggml-backend.h>
#include <llama.h>

#include "ModelBackendName.hpp"
#include "model-interface/BackendSelection.hpp"

#if __has_include(<llama-ext.h>)
#include <llama-ext.h>
#else
// Fabric 0.31 exports this staged API but does not install llama-ext.h.
// Copied from qvac-fabric v11739.4.0 src/llama-ext.h (@qvac/fabric 0.31.1).
// Recheck it against that file on every Fabric bump.
struct llama_memory_breakdown_data {
  size_t model = 0;
  size_t context = 0;
  size_t compute = 0;

  size_t total() const { return model + context + compute; }
};
using llama_memory_breakdown =
    std::map<ggml_backend_buffer_type_t, llama_memory_breakdown_data>;
LLAMA_API llama_memory_breakdown
llama_get_memory_breakdown(const struct llama_context* ctx);
#endif

namespace qvac_lib_inference_addon_embed::backend_reporting {

inline std::string runtimeDeviceBackendName(
    ggml_backend_dev_t device,
    const backend_selection::BackendInterface& bckI) {
  if (device == nullptr) {
    return {};
  }
  if (auto registry = bckI.ggml_backend_dev_backend_reg(device)) {
    const char* name = bckI.ggml_backend_reg_name(registry);
    return canonicalBackendFamily(name != nullptr ? name : "");
  }
  // Only tensor split creates unregistered Meta(...) devices, and embed
  // accepts only none and layer split.
  return {};
}

inline std::string runtimeDeviceBackendName(ggml_backend_dev_t device) {
  const backend_selection::BackendInterface bckI{
      .ggml_backend_dev_backend_reg = ::ggml_backend_dev_backend_reg,
      .ggml_backend_reg_name = ::ggml_backend_reg_name};
  return runtimeDeviceBackendName(device, bckI);
}

inline std::string runtimeModelBackendName(const llama_context* context) {
  if (context == nullptr) {
    return {};
  }
  std::vector<ModelBackendAllocation> allocations;
  for (const auto& [buffer, memory] : llama_get_memory_breakdown(context)) {
    if (memory.model == 0) {
      continue;
    }
    allocations.push_back(
        {memory.model,
         runtimeDeviceBackendName(ggml_backend_buft_get_device(buffer)),
         ggml_backend_buft_is_host(buffer)});
  }
  return modelBackendName(allocations);
}

} // namespace qvac_lib_inference_addon_embed::backend_reporting

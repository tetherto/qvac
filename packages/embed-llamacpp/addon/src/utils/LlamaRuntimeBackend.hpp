#pragma once

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include <ggml-backend.h>
#include <llama.h>

#include "ModelBackendName.hpp"

#if __has_include(<llama-ext.h>)
#include <llama-ext.h>
#elif __has_include(<common/../src/llama-ext.h>)
#include <common/../src/llama-ext.h>
#else
// Fabric 0.25 exports this staged API but does not install llama-ext.h.
// Keep the declaration identical to Fabric's src/llama-ext.h.
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

inline std::string runtimeDeviceBackendName(ggml_backend_dev_t device) {
  if (device == nullptr) {
    return {};
  }
  if (auto registry = ggml_backend_dev_backend_reg(device)) {
    const char* name = ggml_backend_reg_name(registry);
    return canonicalBackendFamily(name != nullptr ? name : "");
  }

  // Tensor split uses an unregistered Meta(device,device,...) device.
  // Match its members against the registry instead of guessing from ordinals.
  const char* rawName = ggml_backend_dev_name(device);
  const std::string name = rawName != nullptr ? rawName : "";
  if (!name.starts_with("Meta(") || !name.ends_with(")")) {
    return {};
  }
  std::vector<ModelBackendAllocation> members;
  size_t offset = 5;
  while (offset < name.size() - 1) {
    const size_t end = name.find_first_of(",)", offset);
    if (end == std::string::npos) {
      return {};
    }
    const std::string member = name.substr(offset, end - offset);
    std::string family;
    for (size_t index = 0; index < ggml_backend_dev_count(); ++index) {
      auto candidate = ggml_backend_dev_get(index);
      const char* candidateName = ggml_backend_dev_name(candidate);
      if (candidateName != nullptr && member == candidateName &&
          candidate != device) {
        family = runtimeDeviceBackendName(candidate);
        break;
      }
    }
    if (family.empty()) {
      return {};
    }
    members.push_back({1, family, false});
    offset = end + 1;
  }
  return modelBackendName(members);
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

#pragma once

#include <algorithm>
#include <cctype>
#include <memory>
#include <string>

#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>

namespace qvac::ttsggml {

inline bool webGpuRequested(std::string backend) {
  std::transform(
      backend.begin(), backend.end(), backend.begin(), [](unsigned char value) {
        return static_cast<char>(std::tolower(value));
      });
  return backend.rfind("webgpu", 0) == 0;
}

inline void requireSupertonicWebGpuSupport(
    const std::string& backend, const std::string& modelPath) {
  if (!webGpuRequested(backend))
    return;
  const gguf_init_params params{true, nullptr};
  std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(
      gguf_init_from_file(modelPath.c_str(), params), gguf_free);
  if (metadata) {
    const auto key = gguf_find_key(metadata.get(), "general.architecture");
    if (key >= 0 && gguf_get_kv_type(metadata.get(), key) == GGUF_TYPE_STRING &&
        std::string(gguf_get_val_str(metadata.get(), key)) == "supertonic3")
      return;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "WebGPU is validated for Supertonic 3 only; a readable Supertonic 3 GGUF "
      "is required");
}

} // namespace qvac::ttsggml

#pragma once

// Shared GGUF metadata accessors — thin wrappers around gguf.h that handle
// missing keys, wrong types, and null pointers without UB.

#include <cstdint>
#include <string>

#include <gguf.h>

namespace qvac_lib_infer_vla_ggml {

inline uint32_t ggufGetU32Or(
    struct gguf_context* g, const char* key, uint32_t dflt) {
  const int64_t idx = gguf_find_key(g, key);
  if (idx < 0) {
    return dflt;
  }
  if (gguf_get_kv_type(g, idx) != GGUF_TYPE_UINT32) {
    return dflt;
  }
  return gguf_get_val_u32(g, idx);
}

inline std::string ggufGetStrOr(
    struct gguf_context* g, const char* key, const std::string& dflt) {
  const int64_t idx = gguf_find_key(g, key);
  if (idx < 0) {
    return dflt;
  }
  if (gguf_get_kv_type(g, idx) != GGUF_TYPE_STRING) {
    return dflt;
  }
  const char* val = gguf_get_val_str(g, idx);
  return val != nullptr ? std::string(val) : dflt;
}

} // namespace qvac_lib_infer_vla_ggml

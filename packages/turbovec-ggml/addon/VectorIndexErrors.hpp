#pragma once
//
// Maps fabric vector-index C error codes to the error names the binding throws.

#include <cstdint>

#include <ggml-vector-index.h>

namespace turbovec_ggml::vector_index_errors {

enum class VecIndexError : std::int32_t {
  Ok = GGML_VEC_INDEX_OK,
  InvalidArgument = GGML_VEC_INDEX_E_INVALID_ARG,
  Duplicate = GGML_VEC_INDEX_E_DUPLICATE,
  NotFound = GGML_VEC_INDEX_E_NOT_FOUND,
  Io = GGML_VEC_INDEX_E_IO,
  BadMagic = GGML_VEC_INDEX_E_BAD_MAGIC,
  BadVersion = GGML_VEC_INDEX_E_BAD_VERSION,
  OutOfMemory = GGML_VEC_INDEX_E_OOM,
  PartialCompact = GGML_VEC_INDEX_E_PARTIAL_COMPACT,
  NotDurable = GGML_VEC_INDEX_E_NOT_DURABLE,
  Internal = GGML_VEC_INDEX_E_INTERNAL,
};

constexpr const char* toString(VecIndexError code) noexcept {
  switch (code) {
  case VecIndexError::Ok:
    return "OK";
  case VecIndexError::InvalidArgument:
    return "InvalidArgument";
  case VecIndexError::Duplicate:
    return "DuplicateId";
  case VecIndexError::NotFound:
    return "NotFound";
  case VecIndexError::Io:
    return "IOError";
  case VecIndexError::BadMagic:
    return "BadMagic";
  case VecIndexError::BadVersion:
    return "BadVersion";
  case VecIndexError::OutOfMemory:
    return "OutOfMemory";
  case VecIndexError::PartialCompact:
    return "PartialCompact";
  case VecIndexError::NotDurable:
    return "NotDurable";
  case VecIndexError::Internal:
    return "InternalError";
  }
  return "UnknownError";
}

} // namespace turbovec_ggml::vector_index_errors

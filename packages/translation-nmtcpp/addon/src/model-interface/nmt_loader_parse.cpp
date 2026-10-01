// NOLINTBEGIN
#include "nmt_loader_parse.hpp"

#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "ggml.h"

#if defined(NMT_BIG_ENDIAN)
template <typename T> static T byteswap(T value) {
  T value_swapped;
  char* source = reinterpret_cast<char*>(&value);
  char* target = reinterpret_cast<char*>(&value_swapped);
  int size = sizeof(T);
  for (int i = 0; i < size; i++) {
    target[size - 1 - i] = source[i];
  }
  return value_swapped;
}
#define NMT_BYTESWAP_VALUE(d) d = byteswap(d)
#else
#define NMT_BYTESWAP_VALUE(d)                                                  \
  do {                                                                         \
  } while (0)
#endif

template <typename T> static bool read_safe(nmt_model_loader* loader, T& dest) {
  if (loader == nullptr || loader->read == nullptr) {
    return false;
  }
  if (loader->read(loader->context, &dest, sizeof(T)) != sizeof(T)) {
    return false;
  }
  NMT_BYTESWAP_VALUE(dest);
  return true;
}

bool nmtReadTensorDims(
    nmt_model_loader* loader, int32_t nDims, int32_t (&ne)[NMT_MAX_TENSOR_DIMS],
    int32_t& nelements) {
  if (nDims < 1 || nDims > NMT_MAX_TENSOR_DIMS) {
    return false;
  }
  int64_t product = 1;
  for (int i = 0; i < nDims; ++i) {
    if (!read_safe(loader, ne[i])) {
      return false;
    }
    if (ne[i] < 1) {
      return false;
    }
    product *= ne[i];
    if (product > INT32_MAX) {
      return false;
    }
  }
  nelements = static_cast<int32_t>(product);
  return true;
}

bool nmtReadBoundedString(
    nmt_model_loader* loader, int64_t length, int64_t maxLength,
    std::string& out) {
  if (loader == nullptr || loader->read == nullptr) {
    return false;
  }
  if (length < 0 || length > maxLength) {
    return false;
  }
  if (length == 0) {
    out.clear();
    return true;
  }
  std::vector<char> buffer(static_cast<size_t>(length));
  if (loader->read(loader->context, buffer.data(), buffer.size()) !=
      buffer.size()) {
    return false;
  }
  out.assign(buffer.data(), buffer.size());
  return true;
}

bool nmtReadTensorName(
    nmt_model_loader* loader, int32_t length, std::string& name) {
  return nmtReadBoundedString(loader, length, NMT_MAX_TENSOR_NAME_LENGTH, name);
}

bool nmtReadCount(nmt_model_loader* loader, int32_t maxCount, int32_t& count) {
  if (!read_safe(loader, count)) {
    return false;
  }
  return count >= 0 && count <= maxCount;
}

bool nmtIsValidTensorType(int32_t ttype) {
  return ttype >= 0 && ttype < GGML_TYPE_COUNT;
}
// NOLINTEND

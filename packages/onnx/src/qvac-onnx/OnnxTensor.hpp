#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace onnx_addon {

enum class TensorType {
  FLOAT32,
  FLOAT16,
  INT64,
  INT32,
  INT8,
  UINT8
};

struct TensorInfo {
  std::string name;
  std::vector<int64_t> shape;
  TensorType type;
};

struct InputTensor {
  std::string name;
  std::vector<int64_t> shape;
  TensorType type = TensorType::FLOAT32;
  const void* data = nullptr;  // Raw pointer to data (caller owns memory)
  size_t dataSize = 0;         // Size in bytes
};

struct OutputTensor {
  std::string name;
  std::vector<int64_t> shape;
  TensorType type;
  std::vector<uint8_t> data;  // Owned copy of output data

  // Get element count from shape
  [[nodiscard]] size_t elementCount() const {
    if (shape.empty()) {
      return 0;
    }
    size_t count = 1;
    for (const auto dim : shape) {
      count *= static_cast<size_t>(dim);
    }
    return count;
  }

  // Get data as typed pointer (const)
  template <typename T>
  [[nodiscard]] const T* as() const {
    return reinterpret_cast<const T*>(data.data());
  }

  // Get data as typed pointer (mutable)
  template <typename T>
  [[nodiscard]] T* asMutable() {
    return reinterpret_cast<T*>(data.data());
  }
};

// Helper to get size of tensor element type in bytes
inline size_t tensorTypeSize(TensorType type) {
  switch (type) {
    case TensorType::FLOAT32:
      return 4;
    case TensorType::FLOAT16:
      return 2;
    case TensorType::INT64:
      return 8;
    case TensorType::INT32:
      return 4;
    case TensorType::INT8:
      return 1;
    case TensorType::UINT8:
      return 1;
    default:
      return 0;
  }
}

}  // namespace onnx_addon

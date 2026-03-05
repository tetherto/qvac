#include "Fp16Utils.hpp"

#include <cstring>

namespace qvac::ttslib::fp16 {

int64_t getNumElements(const chatterbox::OrtTensor &tensor) {
  if (tensor.shape.empty()) {
    return 0;
  }

  int64_t numElements = 1;
  for (const auto &dim : tensor.shape) {
    numElements *= dim;
  }
  return numElements;
}

float toFp32(uint16_t h) {
  uint32_t sign = (h & 0x8000u) << 16u;
  uint32_t exponent = (h >> 10u) & 0x1Fu;
  uint32_t mantissa = h & 0x03FFu;

  if (exponent == 0) {
    if (mantissa == 0) {
      float f;
      std::memcpy(&f, &sign, sizeof(f));
      return f;
    }
    exponent = 1;
    while (!(mantissa & 0x0400u)) {
      mantissa <<= 1u;
      exponent--;
    }
    mantissa &= 0x03FFu;
    exponent = exponent + (127 - 15);
    uint32_t result = sign | (exponent << 23u) | (mantissa << 13u);
    float f;
    std::memcpy(&f, &result, sizeof(f));
    return f;
  }

  if (exponent == 31) {
    uint32_t result = sign | 0x7F800000u | (mantissa << 13u);
    float f;
    std::memcpy(&f, &result, sizeof(f));
    return f;
  }

  exponent = exponent + (127 - 15);
  uint32_t result = sign | (exponent << 23u) | (mantissa << 13u);
  float f;
  std::memcpy(&f, &result, sizeof(f));
  return f;
}

uint16_t fromFp32(float f) {
  uint32_t x;
  std::memcpy(&x, &f, sizeof(x));

  uint16_t sign = (x >> 16u) & 0x8000u;
  int32_t exponent = static_cast<int32_t>((x >> 23u) & 0xFFu) - 127 + 15;
  uint32_t mantissa = x & 0x007FFFFFu;

  if (exponent <= 0) {
    if (exponent < -10)
      return sign;
    mantissa = (mantissa | 0x00800000u) >> (1 - exponent);
    return sign | static_cast<uint16_t>(mantissa >> 13u);
  }

  if (exponent == 0xFF - (127 - 15)) {
    if (mantissa == 0)
      return sign | 0x7C00u;
    return sign | 0x7C00u | static_cast<uint16_t>(mantissa >> 13u);
  }

  if (exponent > 30)
    return sign | 0x7C00u;
  return sign | static_cast<uint16_t>(exponent << 10u) |
         static_cast<uint16_t>(mantissa >> 13u);
}

bool isFp16(const chatterbox::OrtTensor &tensor) {
  return tensor.type == chatterbox::OrtElementType::Fp16;
}

void readTensorToFloatVector(const chatterbox::OrtTensor &tensor,
                             std::vector<float> &dest,
                             std::vector<float>::iterator destStart) {
  const int64_t numElements = getNumElements(tensor);
  if (isFp16(tensor)) {
    const auto *src = static_cast<const uint16_t *>(tensor.data);
    std::vector<float> converted(numElements);
    for (int64_t i = 0; i < numElements; i++) {
      converted[i] = toFp32(src[i]);
    }
    dest.insert(destStart, converted.begin(), converted.end());
  } else {
    const auto *src = static_cast<const float *>(tensor.data);
    dest.insert(destStart, src, src + numElements);
  }
}

void readTensorToFloatBuffer(const chatterbox::OrtTensor &tensor, float *dest,
                             int64_t offset, int64_t count) {
  if (isFp16(tensor)) {
    const auto *src = static_cast<const uint16_t *>(tensor.data) + offset;
    for (int64_t i = 0; i < count; i++) {
      dest[i] = toFp32(src[i]);
    }
  } else {
    const auto *src = static_cast<const float *>(tensor.data) + offset;
    std::memcpy(dest, src, count * sizeof(float));
  }
}

void writeFloatDataToTensor(const chatterbox::OrtTensor &tensor,
                            const float *src, size_t numElements) {
  if (isFp16(tensor)) {
    auto *dest = static_cast<uint16_t *>(tensor.data);
    for (size_t i = 0; i < numElements; i++) {
      dest[i] = fromFp32(src[i]);
    }
  } else {
    std::memcpy(tensor.data, src, numElements * sizeof(float));
  }
}

} // namespace qvac::ttslib::fp16

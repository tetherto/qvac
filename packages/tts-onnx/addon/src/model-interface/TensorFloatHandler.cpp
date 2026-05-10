#include "TensorFloatHandler.hpp"
#include "Fp16Utils.hpp"

#include <cstring>

namespace qvac::ttslib::tensor_float {

namespace {

int64_t getNumElements(const chatterbox::OrtTensor &tensor) {
  if (tensor.shape.empty()) {
    return 0;
  }
  int64_t n = 1;
  for (const auto &dim : tensor.shape) {
    n *= dim;
  }
  return n;
}

class Fp32Handler : public ITensorFloatHandler {
public:
  void readToVector(const chatterbox::OrtTensor &tensor,
                    std::vector<float> &dest,
                    std::vector<float>::iterator destStart) const override {
    const int64_t numElements = getNumElements(tensor);
    const auto *src = static_cast<const float *>(tensor.data);
    dest.insert(destStart, src, src + numElements);
  }
  void readToBuffer(const chatterbox::OrtTensor &tensor, float *dest,
                    int64_t offset, int64_t count) const override {
    const auto *src = static_cast<const float *>(tensor.data) + offset;
    std::memcpy(dest, src, count * sizeof(float));
  }
  void writeFromFloat(const chatterbox::OrtTensor &tensor, const float *src,
                      size_t numElements) const override {
    std::memcpy(tensor.data, src, numElements * sizeof(float));
  }
};

class Fp16Handler : public ITensorFloatHandler {
public:
  void readToVector(const chatterbox::OrtTensor &tensor,
                    std::vector<float> &dest,
                    std::vector<float>::iterator destStart) const override {
    const int64_t numElements = getNumElements(tensor);
    const auto *src = static_cast<const uint16_t *>(tensor.data);
    std::vector<float> converted(numElements);
    for (int64_t i = 0; i < numElements; i++) {
      converted[i] = qvac::ttslib::fp16::toFp32(src[i]);
    }
    dest.insert(destStart, converted.begin(), converted.end());
  }
  void readToBuffer(const chatterbox::OrtTensor &tensor, float *dest,
                    int64_t offset, int64_t count) const override {
    const auto *src = static_cast<const uint16_t *>(tensor.data) + offset;
    for (int64_t i = 0; i < count; i++) {
      dest[i] = qvac::ttslib::fp16::toFp32(src[i]);
    }
  }
  void writeFromFloat(const chatterbox::OrtTensor &tensor, const float *src,
                      size_t numElements) const override {
    auto *out = static_cast<uint16_t *>(tensor.data);
    for (size_t i = 0; i < numElements; i++) {
      out[i] = qvac::ttslib::fp16::fromFp32(src[i]);
    }
  }
};

float int4NibbleToFp32(uint8_t packed, bool highNibble) {
  uint8_t n = highNibble ? (packed >> 4u) & 0x0Fu : packed & 0x0Fu;
  int8_t s = static_cast<int8_t>(n << 4) >> 4;
  return static_cast<float>(s);
}

uint8_t fp32ToInt4Nibble(float f) {
  int v = static_cast<int>(f);
  if (v > 7)
    v = 7;
  if (v < -8)
    v = -8;
  return static_cast<uint8_t>(v & 0x0Fu);
}

float uint4NibbleToFp32(uint8_t packed, bool highNibble) {
  uint8_t n = highNibble ? (packed >> 4u) & 0x0Fu : packed & 0x0Fu;
  return static_cast<float>(n);
}

uint8_t fp32ToUInt4Nibble(float f) {
  int v = static_cast<int>(f);
  if (v > 15)
    v = 15;
  if (v < 0)
    v = 0;
  return static_cast<uint8_t>(v & 0x0Fu);
}

class Int4Handler : public ITensorFloatHandler {
public:
  void readToVector(const chatterbox::OrtTensor &tensor,
                    std::vector<float> &dest,
                    std::vector<float>::iterator destStart) const override {
    const int64_t numElements = getNumElements(tensor);
    const auto *src = static_cast<const uint8_t *>(tensor.data);
    std::vector<float> converted(numElements);
    for (int64_t i = 0; i < numElements; i++) {
      size_t byteIdx = static_cast<size_t>(i) / 2;
      bool high = (i % 2) != 0;
      converted[i] = int4NibbleToFp32(src[byteIdx], high);
    }
    dest.insert(destStart, converted.begin(), converted.end());
  }
  void readToBuffer(const chatterbox::OrtTensor &tensor, float *dest,
                    int64_t offset, int64_t count) const override {
    const auto *src = static_cast<const uint8_t *>(tensor.data);
    for (int64_t i = 0; i < count; i++) {
      size_t byteIdx = static_cast<size_t>(offset + i) / 2;
      bool high = ((offset + i) % 2) != 0;
      dest[i] = int4NibbleToFp32(src[byteIdx], high);
    }
  }
  void writeFromFloat(const chatterbox::OrtTensor &tensor, const float *src,
                      size_t numElements) const override {
    auto *out = static_cast<uint8_t *>(tensor.data);
    for (size_t i = 0; i < numElements; i++) {
      size_t byteIdx = i / 2;
      uint8_t nibble = fp32ToInt4Nibble(src[i]);
      if (i % 2 == 0) {
        out[byteIdx] = (out[byteIdx] & 0xF0u) | (nibble & 0x0Fu);
      } else {
        out[byteIdx] = (out[byteIdx] & 0x0Fu) | (nibble << 4u);
      }
    }
  }
};

class UInt4Handler : public ITensorFloatHandler {
public:
  void readToVector(const chatterbox::OrtTensor &tensor,
                    std::vector<float> &dest,
                    std::vector<float>::iterator destStart) const override {
    const int64_t numElements = getNumElements(tensor);
    const auto *src = static_cast<const uint8_t *>(tensor.data);
    std::vector<float> converted(numElements);
    for (int64_t i = 0; i < numElements; i++) {
      size_t byteIdx = static_cast<size_t>(i) / 2;
      bool high = (i % 2) != 0;
      converted[i] = uint4NibbleToFp32(src[byteIdx], high);
    }
    dest.insert(destStart, converted.begin(), converted.end());
  }
  void readToBuffer(const chatterbox::OrtTensor &tensor, float *dest,
                    int64_t offset, int64_t count) const override {
    const auto *src = static_cast<const uint8_t *>(tensor.data);
    for (int64_t i = 0; i < count; i++) {
      size_t byteIdx = static_cast<size_t>(offset + i) / 2;
      bool high = ((offset + i) % 2) != 0;
      dest[i] = uint4NibbleToFp32(src[byteIdx], high);
    }
  }
  void writeFromFloat(const chatterbox::OrtTensor &tensor, const float *src,
                      size_t numElements) const override {
    auto *out = static_cast<uint8_t *>(tensor.data);
    for (size_t i = 0; i < numElements; i++) {
      size_t byteIdx = i / 2;
      uint8_t nibble = fp32ToUInt4Nibble(src[i]);
      if (i % 2 == 0) {
        out[byteIdx] = (out[byteIdx] & 0xF0u) | (nibble & 0x0Fu);
      } else {
        out[byteIdx] = (out[byteIdx] & 0x0Fu) | (nibble << 4u);
      }
    }
  }
};

const Fp32Handler s_fp32;
const Fp16Handler s_fp16;
const Int4Handler s_int4;
const UInt4Handler s_uint4;

} // namespace

const ITensorFloatHandler &
TensorFloatHandlerFactory::get(chatterbox::OrtElementType type) {
  switch (type) {
  case chatterbox::OrtElementType::Fp32:
    return s_fp32;
  case chatterbox::OrtElementType::Fp16:
    return s_fp16;
  case chatterbox::OrtElementType::Int4:
    return s_int4;
  case chatterbox::OrtElementType::UInt4:
    return s_uint4;
  default:
    return s_fp32;
  }
}

} // namespace qvac::ttslib::tensor_float

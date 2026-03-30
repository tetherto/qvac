#pragma once

#include "OrtTypes.hpp"

#include <cstdint>
#include <vector>

namespace qvac::ttslib::chatterbox {
struct OrtTensor;
}

namespace qvac::ttslib::tensor_float {

class ITensorFloatHandler {
public:
  virtual ~ITensorFloatHandler() = default;
  virtual void readToVector(const chatterbox::OrtTensor &tensor,
                            std::vector<float> &dest,
                            std::vector<float>::iterator destStart) const = 0;
  virtual void readToBuffer(const chatterbox::OrtTensor &tensor, float *dest,
                            int64_t offset, int64_t count) const = 0;
  virtual void writeFromFloat(const chatterbox::OrtTensor &tensor,
                              const float *src, size_t numElements) const = 0;
};

class TensorFloatHandlerFactory {
public:
  static const ITensorFloatHandler &get(chatterbox::OrtElementType type);
};

} // namespace qvac::ttslib::tensor_float

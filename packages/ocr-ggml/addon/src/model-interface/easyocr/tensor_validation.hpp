#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>

#include <ggml.h>

namespace easyocr::ggml {

inline void validate_detection_tensor(const ggml_tensor& tensor, size_t bytes) {
  constexpr size_t channels = 2;
  constexpr size_t bytesPerPixel = channels * sizeof(float);
  if (tensor.type != GGML_TYPE_F32 || tensor.ne[0] != channels ||
      tensor.ne[3] != 1 || tensor.ne[1] <= 0 || tensor.ne[2] <= 0 ||
      tensor.ne[1] > std::numeric_limits<int>::max() ||
      tensor.ne[2] > std::numeric_limits<int>::max()) {
    throw std::runtime_error("invalid detection output tensor shape");
  }
  const auto width = static_cast<size_t>(tensor.ne[1]);
  const auto height = static_cast<size_t>(tensor.ne[2]);
  if (width > std::numeric_limits<size_t>::max() / bytesPerPixel / height ||
      bytes != width * height * bytesPerPixel) {
    throw std::runtime_error("invalid detection output tensor size");
  }
}

inline void validate_vocab_index(size_t index, size_t vocabSize) {
  if (index >= vocabSize) {
    throw std::runtime_error("class index exceeds vocabulary");
  }
}

inline bool bias_tensor_size_matches(size_t biasSize, int64_t channels) {
  return channels > 0 && biasSize == static_cast<size_t>(channels);
}

inline bool prediction_bias_matches(const ggml_tensor& bias, int64_t classes) {
  return classes > 0 && ggml_n_dims(&bias) == 1 &&
         bias.ne[0] == classes && ggml_nelements(&bias) == classes;
}

}

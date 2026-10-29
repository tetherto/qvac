#pragma once

#include <cstdint>
#include <optional>
#include <vector>

namespace classification_ggml {

struct RawRgbDims {
  uint32_t width;
  uint32_t height;
  uint32_t channels;
};

struct ImageInput {
  std::vector<uint8_t> data;
  std::optional<RawRgbDims> rawRgb;
};

} // namespace classification_ggml

#pragma once

#include <cstdint>
#include <vector>

#include <stable-diffusion.h>

namespace image_codec {

struct FreeDeleter {
  void operator()(uint8_t* ptr) const noexcept;
};

std::vector<uint8_t> encodeToPng(const sd_image_t& image);
sd_image_t decodeImage(const std::vector<uint8_t>& imageBytes);

} // namespace image_codec

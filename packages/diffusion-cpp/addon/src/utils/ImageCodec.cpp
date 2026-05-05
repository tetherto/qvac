#include "ImageCodec.hpp"

#include <cstdlib>
#include <limits>

#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>

namespace image_codec {

void FreeDeleter::operator()(uint8_t* ptr) const noexcept { free(ptr); }

std::vector<uint8_t> encodeToPng(const sd_image_t& img) {
  std::vector<uint8_t> out;
  const auto [width, height, channel, data] = img;
  if (!data || width == 0 || height == 0 || channel == 0 || channel > 4) {
    return out;
  }
  if (width > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
      height > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
    return out;
  }

  const uint64_t stride =
      static_cast<uint64_t>(width) * static_cast<uint64_t>(channel);
  if (stride > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
    return out;
  }

  auto writeCallback = [](void* ctx, void* data, int size) {
    auto* vec = static_cast<std::vector<uint8_t>*>(ctx);
    vec->insert(
        vec->end(),
        static_cast<const uint8_t*>(data),
        static_cast<const uint8_t*>(data) + size);
  };
  const int ok = stbi_write_png_to_func(
      writeCallback,
      &out,
      static_cast<int>(width),
      static_cast<int>(height),
      static_cast<int>(channel),
      data,
      static_cast<int>(stride));
  if (ok == 0) {
    out.clear();
  }
  return out;
}

sd_image_t decodeImage(const std::vector<uint8_t>& imageBytes) {
  if (imageBytes.empty() ||
      imageBytes.size() >
          static_cast<size_t>(std::numeric_limits<int>::max())) {
    return sd_image_t{};
  }

  int w = 0;
  int h = 0;
  int c = 0;
  uint8_t* data = stbi_load_from_memory(
      imageBytes.data(), static_cast<int>(imageBytes.size()), &w, &h, &c, 3);
  if (!data) {
    return sd_image_t{};
  }

  return sd_image_t{
      static_cast<uint32_t>(w), static_cast<uint32_t>(h), 3, data};
}

} // namespace image_codec

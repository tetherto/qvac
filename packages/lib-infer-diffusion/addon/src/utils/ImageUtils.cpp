#include "ImageUtils.hpp"

#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include <cstdlib>

#include <stb_image_resize2.h>

namespace image_utils {

sd_image_t resizeSdImage(const sd_image_t& src, int dstW, int dstH) {
  const int srcW = static_cast<int>(src.width);
  const int srcH = static_cast<int>(src.height);
  const int ch = static_cast<int>(src.channel);

  auto* buf = static_cast<uint8_t*>(malloc(
      static_cast<size_t>(dstW) * static_cast<size_t>(dstH) *
      static_cast<size_t>(ch)));
  if (!buf)
    return sd_image_t{};

  unsigned char* ok = stbir_resize_uint8_linear(
      src.data,
      srcW,
      srcH,
      srcW * ch,
      buf,
      dstW,
      dstH,
      dstW * ch,
      static_cast<stbir_pixel_layout>(ch));

  if (!ok) {
    free(buf);
    return sd_image_t{};
  }

  return {
      static_cast<uint32_t>(dstW),
      static_cast<uint32_t>(dstH),
      static_cast<uint32_t>(ch),
      buf};
}

} // namespace image_utils

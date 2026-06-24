#include "ImageUtils.hpp"

#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include <climits>
#include <cstdint>
#include <cstdlib>

#include <stb_image_resize2.h>

namespace image_utils {

sd_image_t resizeSdImage(const sd_image_t& src, int dstW, int dstH) {
  // Reject anything we cannot trust before we touch malloc. Negative or
  // zero dimensions, channel counts outside the stb-supported [1, 4] range,
  // and any dst*src product that would overflow size_t — all of these
  // would otherwise allocate too small a buffer and corrupt the heap when
  // stbir_resize_uint8_linear writes into it.
  const int srcW = static_cast<int>(src.width);
  const int srcH = static_cast<int>(src.height);
  const int ch = static_cast<int>(src.channel);

  if (dstW <= 0 || dstH <= 0 || srcW <= 0 || srcH <= 0 || ch < 1 || ch > 4) {
    return sd_image_t{};
  }

  // Overflow-checked allocation size: dstW * dstH * ch.
  const auto dW = static_cast<size_t>(dstW);
  const auto dH = static_cast<size_t>(dstH);
  const auto cN = static_cast<size_t>(ch);
  if (dW > SIZE_MAX / dH) {
    return sd_image_t{};
  }
  const size_t pixels = dW * dH;
  if (pixels > SIZE_MAX / cN) {
    return sd_image_t{};
  }
  const size_t bytes = pixels * cN;

  // Stride math runs through stb's `int` API, so reject inputs whose
  // row-byte stride does not fit in a positive int (stb interprets a
  // negative stride as "flip rows").
  const auto srcStride = static_cast<size_t>(srcW) * cN;
  const auto dstStride = static_cast<size_t>(dstW) * cN;
  if (srcStride > static_cast<size_t>(INT_MAX) ||
      dstStride > static_cast<size_t>(INT_MAX)) {
    return sd_image_t{};
  }

  auto* buf = static_cast<uint8_t*>(malloc(bytes));
  if (!buf)
    return sd_image_t{};

  unsigned char* ok = stbir_resize_uint8_linear(
      src.data,
      srcW,
      srcH,
      static_cast<int>(srcStride),
      buf,
      dstW,
      dstH,
      static_cast<int>(dstStride),
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

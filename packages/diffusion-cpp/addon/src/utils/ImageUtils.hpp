#pragma once

#include <stable-diffusion.h>

namespace image_utils {

/// Resize an sd_image_t to (dstW x dstH) using linear filtering
/// (stb_image_resize2).
/// Returns a new sd_image_t whose .data is malloc'd (caller must free).
/// On failure the returned image has .data == nullptr.
sd_image_t resizeSdImage(const sd_image_t& src, int dstW, int dstH);

} // namespace image_utils

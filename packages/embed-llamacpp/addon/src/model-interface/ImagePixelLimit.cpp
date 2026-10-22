#include "ImagePixelLimit.hpp"

#include <algorithm>
#include <climits>
#include <cstring>
#include <limits>
#include <string>

#include <inference-addon-cpp/Errors.hpp>

#include "addon/BertErrors.hpp"
#include "logging.hpp"

#define STB_IMAGE_STATIC
#define STB_IMAGE_IMPLEMENTATION
// fabric's copy, so the dimension check parses headers like mtmd-helper does.
#include <llama/stb/stb_image.h>

using namespace qvac_lib_infer_llamacpp_embed::errors;

namespace image_pixel_limit {
namespace {
constexpr uint64_t PIXELS_PER_MEGAPIXEL = 1'000'000;

[[noreturn]] void throwUnsupportedMedia(const std::string& message) {
  qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
      GGML_LOG_LEVEL_WARN, (message + "\n").c_str(), nullptr);
  throw qvac_errors::StatusError(ADDON_ID, toString(UnsupportedMedia), message);
}

void checkDimensions(int width, int height, uint64_t maxPixels) {
  if (width == 0 || height == 0) {
    throwUnsupportedMedia(
        "[ImagePixelLimit] Unsupported or corrupt image: cannot determine "
        "dimensions before decoding.");
  }
  // A top-down BMP stores a negative height.
  const auto absWidth = width < 0 ? -int64_t{width} : int64_t{width};
  const auto absHeight = height < 0 ? -int64_t{height} : int64_t{height};
  const auto pixels =
      static_cast<uint64_t>(absWidth) * static_cast<uint64_t>(absHeight);
  if (pixels <= maxPixels) {
    return;
  }
  throwUnsupportedMedia(
      "[ImagePixelLimit] Image " + std::to_string(absWidth) + " x " +
      std::to_string(absHeight) + " exceeds the " +
      std::to_string(maxPixels / PIXELS_PER_MEGAPIXEL) +
      " MP limit. Increase image-max-megapixels to allow larger images.");
}
} // namespace

bool isMtmdAudio(const uint8_t* data, size_t size) {
  if (data == nullptr || size < 12) {
    return false;
  }
  const bool wav = std::memcmp(data, "RIFF", 4) == 0 &&
                   std::memcmp(data + 8, "WAVE", 4) == 0;
  const bool mp3 = std::memcmp(data, "ID3", 3) == 0 ||
                   (data[0] == 0xff && (data[1] & 0xe0) == 0xe0);
  const bool flac = std::memcmp(data, "fLaC", 4) == 0;
  return wav || mp3 || flac;
}

void checkBuffer(const uint8_t* data, size_t size, uint64_t maxPixels) {
  if (data == nullptr || size == 0) {
    throwUnsupportedMedia("[ImagePixelLimit] Media buffer is empty");
  }
  // Keep this magic check aligned with mtmd-helper's audio dispatch.
  if (isMtmdAudio(data, size)) {
    return;
  }
  int width = 0;
  int height = 0;
  int channels = 0;
  const auto infoSize =
      static_cast<int>(std::min(size, static_cast<size_t>(INT_MAX)));
  // An image whose size stb_image cannot read (e.g. WebP, which mtmd-helper
  // would hand to ffmpeg) is rejected rather than decoded unchecked.
  if (stbi_info_from_memory(data, infoSize, &width, &height, &channels) == 0) {
    width = 0;
    height = 0;
  }
  checkDimensions(width, height, maxPixels);
}

} // namespace image_pixel_limit

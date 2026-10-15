#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <stable-diffusion.h>

namespace image_codec {

inline constexpr uint64_t MAX_DECODED_PIXELS = 64ULL * 1024 * 1024;
inline constexpr uint64_t MAX_JOB_DECODED_PIXELS = 128ULL * 1024 * 1024;
inline constexpr uint64_t MAX_CONFIGURED_IMAGE_PIXELS = 16384ULL * 16384;

enum class DecodeFailure {
  None,
  UnsupportedFormat,
  CompressedInputLimit,
  InvalidHeader,
  DimensionLimit,
  PixelLimit,
  JobPixelLimit,
  HighMemoryInputLimit,
  PngInflateLimit,
  JpegScanLimit,
  InvalidData,
};

std::string decodeFailureMessage(
    DecodeFailure failure, uint64_t imagePixelLimit = MAX_DECODED_PIXELS,
    uint64_t jobPixelLimit = MAX_JOB_DECODED_PIXELS);

struct FreeDeleter {
  void operator()(uint8_t* ptr) const noexcept;
};

std::vector<uint8_t> encodeToPng(const sd_image_t& image);
// Lossy JPEG encode (quality 1..100). Returns empty vector on failure.
// JPEG has no alpha: channel must be 1 or 3.
std::vector<uint8_t> encodeToJpeg(const sd_image_t& image, int quality);
sd_image_t decodeImage(
    const std::vector<uint8_t>& imageBytes,
    uint64_t pixelLimit = MAX_DECODED_PIXELS, DecodeFailure* failure = nullptr,
    uint64_t imagePixelLimit = MAX_DECODED_PIXELS);

} // namespace image_codec

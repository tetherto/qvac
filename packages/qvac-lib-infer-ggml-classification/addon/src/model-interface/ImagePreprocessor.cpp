#include "ImagePreprocessor.hpp"

#include <algorithm>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <string>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

// Single-header implementations must only be emitted in exactly one TU.
// ImagePreprocessor is the chosen owner for the whole addon.
#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include <stb_image.h>
#include <stb_image_resize2.h>

namespace qvac_lib_infer_ggml_classification::preprocess {

namespace {
using qvac_errors::general_error::InvalidArgument;
using qvac_errors::StatusError;

constexpr size_t kDecodedChannels = 3;

[[noreturn]] void raise(const std::string& message) {
  throw StatusError(InvalidArgument, message);
}

bool startsWith(
    std::span<const uint8_t> buffer, std::span<const uint8_t> prefix) {
  if (buffer.size() < prefix.size()) {
    return false;
  }
  for (size_t i = 0; i < prefix.size(); ++i) {
    if (buffer[i] != prefix[i]) {
      return false;
    }
  }
  return true;
}
} // namespace

bool isEncodedImage(std::span<const uint8_t> buffer) {
  // JPEG: FF D8 FF ...
  constexpr std::array<uint8_t, 3> kJpegMagic = {0xFF, 0xD8, 0xFF};
  // PNG:  89 50 4E 47 0D 0A 1A 0A
  constexpr std::array<uint8_t, 8> kPngMagic = {
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};

  return startsWith(buffer, kJpegMagic) || startsWith(buffer, kPngMagic);
}

std::vector<uint8_t> decodeToRgb(
    std::span<const uint8_t> encodedBuffer, uint32_t& outWidth,
    uint32_t& outHeight) {
  if (encodedBuffer.empty()) {
    raise("Input image buffer is empty");
  }
  if (encodedBuffer.size() >
      static_cast<size_t>(std::numeric_limits<int>::max())) {
    raise("Input image buffer too large for decoder");
  }

  int width = 0;
  int height = 0;
  int channelsIgnored = 0;
  // stb_image forces 3 output channels so downstream code never has to deal
  // with alpha or grayscale.
  uint8_t* pixels = stbi_load_from_memory(
      encodedBuffer.data(), static_cast<int>(encodedBuffer.size()), &width,
      &height, &channelsIgnored, static_cast<int>(kDecodedChannels));

  if (pixels == nullptr) {
    const char* reason = stbi_failure_reason();
    std::string msg = "Failed to decode image (only JPEG and PNG are supported)";
    if (reason != nullptr) {
      msg += ": ";
      msg += reason;
    }
    raise(msg);
  }

  if (width <= 0 || height <= 0) {
    stbi_image_free(pixels);
    raise("Decoded image has invalid dimensions");
  }
  if (static_cast<uint32_t>(width) > kMaxImageDimension ||
      static_cast<uint32_t>(height) > kMaxImageDimension) {
    stbi_image_free(pixels);
    raise(
        "Image exceeds maximum allowed dimension (" +
        std::to_string(kMaxImageDimension) + " px per axis)");
  }

  const size_t byteCount = static_cast<size_t>(width) *
                           static_cast<size_t>(height) * kDecodedChannels;
  std::vector<uint8_t> out(pixels, pixels + byteCount);
  stbi_image_free(pixels);

  outWidth = static_cast<uint32_t>(width);
  outHeight = static_cast<uint32_t>(height);
  return out;
}

void validateRawRgb(
    std::span<const uint8_t> rawBuffer, uint32_t width, uint32_t height,
    uint32_t channels) {
  if (rawBuffer.empty()) {
    raise("Raw image buffer is empty");
  }
  if (channels != kChannels) {
    raise(
        "Raw image must have exactly 3 channels (RGB); got " +
        std::to_string(channels));
  }
  if (width == 0 || height == 0) {
    raise("Raw image width and height must be greater than zero");
  }
  if (width > kMaxImageDimension || height > kMaxImageDimension) {
    raise(
        "Raw image exceeds maximum allowed dimension (" +
        std::to_string(kMaxImageDimension) + " px per axis)");
  }
  const size_t expected = static_cast<size_t>(width) *
                          static_cast<size_t>(height) *
                          static_cast<size_t>(channels);
  if (rawBuffer.size() != expected) {
    raise(
        "Raw image buffer size " + std::to_string(rawBuffer.size()) +
        " does not match declared dimensions " + std::to_string(width) + "x" +
        std::to_string(height) + "x" + std::to_string(channels) +
        " (expected " + std::to_string(expected) + " bytes)");
  }
}

std::vector<uint8_t> resizeToInput(
    std::span<const uint8_t> srcRgb, uint32_t srcWidth, uint32_t srcHeight) {
  std::vector<uint8_t> out(kInputSize * kInputSize * kChannels);
  unsigned char* ok = stbir_resize_uint8_linear(
      srcRgb.data(), static_cast<int>(srcWidth), static_cast<int>(srcHeight),
      static_cast<int>(srcWidth * kChannels), out.data(),
      static_cast<int>(kInputSize), static_cast<int>(kInputSize),
      static_cast<int>(kInputSize * kChannels), STBIR_RGB);
  if (ok == nullptr) {
    raise("Failed to resize image to 224x224");
  }
  return out;
}

std::vector<float> normalizeToWhcn(std::span<const uint8_t> rgb224) {
  if (rgb224.size() !=
      static_cast<size_t>(kInputSize) * kInputSize * kChannels) {
    raise("Internal error: resized buffer does not have expected size");
  }
  constexpr float kUnit = 1.0F / 255.0F;

  // WHCN layout = ggml 4D order (width, height, channels, batch). For a
  // contiguous 4D tensor, the fastest-varying axis is width. In index math:
  //   offset(w, h, c) = c*H*W + h*W + w
  std::vector<float> out(static_cast<size_t>(kInputSize) * kInputSize * kChannels);
  const size_t plane = static_cast<size_t>(kInputSize) * kInputSize;

  for (uint32_t y = 0; y < kInputSize; ++y) {
    for (uint32_t x = 0; x < kInputSize; ++x) {
      const size_t srcIdx =
          (static_cast<size_t>(y) * kInputSize + x) * kChannels;
      const size_t dstBase = static_cast<size_t>(y) * kInputSize + x;
      for (uint32_t c = 0; c < kChannels; ++c) {
        const float pixel = static_cast<float>(rgb224[srcIdx + c]) * kUnit;
        out[c * plane + dstBase] =
            (pixel - kImageNetMean[c]) / kImageNetStd[c];
      }
    }
  }
  return out;
}

std::vector<float> preprocessToTensor(
    std::span<const uint8_t> input, uint32_t declaredWidth,
    uint32_t declaredHeight, uint32_t declaredChannels) {
  if (input.empty()) {
    raise("Input image buffer is empty");
  }

  std::vector<uint8_t> rgb;
  uint32_t width = 0;
  uint32_t height = 0;

  if (declaredWidth > 0 || declaredHeight > 0 || declaredChannels > 0) {
    validateRawRgb(input, declaredWidth, declaredHeight, declaredChannels);
    rgb.assign(input.begin(), input.end());
    width = declaredWidth;
    height = declaredHeight;
  } else {
    if (!isEncodedImage(input)) {
      raise(
          "Unsupported image format: expected JPEG or PNG, or pass "
          "'{ width, height, channels: 3 }' with raw RGB bytes");
    }
    rgb = decodeToRgb(input, width, height);
  }

  std::vector<uint8_t> resized = resizeToInput(rgb, width, height);
  return normalizeToWhcn(resized);
}

} // namespace qvac_lib_infer_ggml_classification::preprocess

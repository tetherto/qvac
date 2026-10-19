#include "ImageCodec.hpp"

#include <algorithm>
#include <array>
#include <iterator>
#include <limits>
#include <memory>

#define STBI_NO_HDR
#define STBI_NO_TGA
#define STBI_NO_PSD
#define STBI_NO_PIC
#define STBI_NO_PNM
#define STBI_NO_GIF
#define STBI_NO_BMP
#define STBI_MAX_DIMENSIONS 16384

// clang-analyzer reports false-positive leaks inside STB implementation paths
// that are not owned by this wrapper. Normal builds still compile the
// implementation here; analyzer runs only need the declarations.
#if defined(__clang_analyzer__)
#include <stb_image.h>
#include <stb_image_write.h>
#else
#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>
#endif

namespace image_codec {

namespace {

constexpr uint64_t MAX_16_BIT_PNG_SOURCE_BYTES = 64ULL * 1024 * 1024;
constexpr uint64_t MAX_FOUR_COMPONENT_JPEG_SOURCE_BYTES = 128ULL * 1024 * 1024;
constexpr int MAX_JPEG_SCANS = 32;

uint32_t readBigEndian32(const uint8_t* bytes) {
  return (static_cast<uint32_t>(bytes[0]) << 24) |
         (static_cast<uint32_t>(bytes[1]) << 16) |
         (static_cast<uint32_t>(bytes[2]) << 8) | bytes[3];
}

bool validatePngInflate(
    const std::vector<uint8_t>& bytes, int width, int height,
    int sourceChannels, DecodeFailure& failure) {
  constexpr uint32_t ihdr = 0x49484452;
  constexpr uint32_t idat = 0x49444154;
  constexpr uint32_t iend = 0x49454E44;
  constexpr uint32_t cgbi = 0x43674249;
  std::vector<uint8_t> compressed;
  bool hasHeader = false;
  bool hasData = false;
  bool hasEnd = false;
  bool rawDeflate = false;
  int depth = 0;
  int color = 0;
  int interlace = 0;

  for (size_t pos = 8; pos + 12 <= bytes.size();) {
    const auto length =
        static_cast<size_t>(readBigEndian32(bytes.data() + pos));
    const auto type = readBigEndian32(bytes.data() + pos + 4);
    if (length > bytes.size() - pos - 12) {
      failure = DecodeFailure::InvalidData;
      return false;
    }
    const size_t payload = pos + 8;
    if (type == cgbi && !hasHeader) {
      rawDeflate = true;
    } else if (type == ihdr) {
      if (hasHeader || length != 13 ||
          readBigEndian32(bytes.data() + payload) !=
              static_cast<uint32_t>(width) ||
          readBigEndian32(bytes.data() + payload + 4) !=
              static_cast<uint32_t>(height)) {
        failure = DecodeFailure::InvalidHeader;
        return false;
      }
      hasHeader = true;
      depth = bytes[payload + 8];
      color = bytes[payload + 9];
      interlace = bytes[payload + 12];
    } else if (type == idat) {
      if (!hasHeader) {
        failure = DecodeFailure::InvalidHeader;
        return false;
      }
      hasData = true;
      compressed.insert(
          compressed.end(),
          bytes.data() + payload,
          bytes.data() + payload + length);
    } else if (type == iend) {
      hasEnd = true;
      break;
    }
    pos = payload + length + 4;
  }
  if (!hasHeader || !hasData || !hasEnd || compressed.empty()) {
    failure = DecodeFailure::InvalidData;
    return false;
  }
  const uint64_t pixels = static_cast<uint64_t>(width) * height;
  if (depth == 16 &&
      pixels * sourceChannels * 2 > MAX_16_BIT_PNG_SOURCE_BYTES) {
    failure = DecodeFailure::HighMemoryInputLimit;
    return false;
  }

  int encodedChannels = 0;
  switch (color) {
  case 0:
  case 3:
    encodedChannels = 1;
    break;
  case 2:
    encodedChannels = 3;
    break;
  case 4:
    encodedChannels = 2;
    break;
  case 6:
    encodedChannels = 4;
    break;
  default:
    failure = DecodeFailure::InvalidHeader;
    return false;
  }
  uint64_t inflatedBytes = 0;
  const auto addPass = [&](uint64_t passWidth, uint64_t passHeight) {
    if (passWidth != 0 && passHeight != 0) {
      inflatedBytes +=
          passHeight * (1 + (passWidth * encodedChannels * depth + 7) / 8);
    }
  };
  if (interlace == 0) {
    addPass(width, height);
  } else if (interlace == 1) {
    constexpr std::array<int, 7> startX = {0, 4, 0, 2, 0, 1, 0};
    constexpr std::array<int, 7> startY = {0, 0, 4, 0, 2, 0, 1};
    constexpr std::array<int, 7> stepX = {8, 8, 4, 4, 2, 2, 1};
    constexpr std::array<int, 7> stepY = {8, 8, 8, 4, 4, 2, 2};
    for (size_t pass = 0; pass < startX.size(); ++pass) {
      if (width > startX[pass] && height > startY[pass]) {
        addPass(
            (width - startX[pass] + stepX[pass] - 1) / stepX[pass],
            (height - startY[pass] + stepY[pass] - 1) / stepY[pass]);
      }
    }
  } else {
    failure = DecodeFailure::InvalidHeader;
    return false;
  }
  constexpr uint64_t inflateSlackBytes = 64ULL * 1024;
  if (inflatedBytes == 0 ||
      inflatedBytes > static_cast<uint64_t>(std::numeric_limits<int>::max()) -
                          inflateSlackBytes) {
    failure = DecodeFailure::PngInflateLimit;
    return false;
  }
  std::vector<char> inflated(
      static_cast<size_t>(inflatedBytes + inflateSlackBytes));
  const int actual = rawDeflate
                         ? stbi_zlib_decode_noheader_buffer(
                               inflated.data(),
                               static_cast<int>(inflated.size()),
                               reinterpret_cast<const char*>(compressed.data()),
                               static_cast<int>(compressed.size()))
                         : stbi_zlib_decode_buffer(
                               inflated.data(),
                               static_cast<int>(inflated.size()),
                               reinterpret_cast<const char*>(compressed.data()),
                               static_cast<int>(compressed.size()));
  if (actual < 0 || static_cast<uint64_t>(actual) < inflatedBytes) {
    failure = DecodeFailure::PngInflateLimit;
    return false;
  }
  return true;
}

bool validateJpegScans(
    const std::vector<uint8_t>& bytes, uint64_t pixels,
    DecodeFailure& failure) {
  size_t pos = 2;
  int scans = 0;
  bool seenFrame = false;
  while (pos < bytes.size()) {
    if (bytes[pos] != 0xFF) {
      if (seenFrame) {
        failure = DecodeFailure::InvalidData;
        return false;
      }
      ++pos;
      continue;
    }
    ++pos;
    while (pos < bytes.size() && bytes[pos] == 0xFF) {
      ++pos;
    }
    if (pos == bytes.size()) {
      break;
    }
    const uint8_t marker = bytes[pos++];
    if (marker == 0xD9) {
      return scans > 0;
    }
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      continue;
    }
    if (pos + 2 > bytes.size()) {
      break;
    }
    const size_t length =
        (static_cast<size_t>(bytes[pos]) << 8) | bytes[pos + 1];
    if (length < 2 || length > bytes.size() - pos) {
      failure = DecodeFailure::InvalidData;
      return false;
    }
    if ((marker == 0xC0 || marker == 0xC1 || marker == 0xC2) && length >= 8 &&
        bytes[pos + 7] == 4 &&
        pixels * 4 > MAX_FOUR_COMPONENT_JPEG_SOURCE_BYTES) {
      failure = DecodeFailure::HighMemoryInputLimit;
      return false;
    }
    if (marker == 0xC0 || marker == 0xC1 || marker == 0xC2) {
      seenFrame = true;
    }
    pos += length;
    if (marker != 0xDA) {
      continue;
    }
    if (++scans > MAX_JPEG_SCANS) {
      failure = DecodeFailure::JpegScanLimit;
      return false;
    }
    while (pos < bytes.size()) {
      if (bytes[pos] != 0xFF) {
        ++pos;
        continue;
      }
      const size_t markerStart = pos++;
      while (pos < bytes.size() && bytes[pos] == 0xFF) {
        ++pos;
      }
      if (pos == bytes.size()) {
        break;
      }
      const uint8_t next = bytes[pos];
      if (next == 0 || (next >= 0xD0 && next <= 0xD7)) {
        ++pos;
      } else {
        pos = markerStart;
        break;
      }
    }
  }
  if (scans == 0) {
    failure = DecodeFailure::InvalidData;
    return false;
  }
  return true;
}

// STB requires this exact C callback shape for stbi_write_*_to_func.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void writePngBytes(void* context, void* payload, int payloadSize) {
  if (context == nullptr || payload == nullptr || payloadSize <= 0) {
    return;
  }

  auto* output = static_cast<std::vector<uint8_t>*>(context);
  const auto* bytes = static_cast<const uint8_t*>(payload);
  std::copy_n(
      bytes,
      static_cast<std::size_t>(payloadSize),
      std::back_inserter(*output));
}

} // namespace

std::string decodeFailureMessage(
    DecodeFailure failure, uint64_t imagePixelLimit, uint64_t jobPixelLimit) {
  const auto describePixels = [](uint64_t pixels) {
    constexpr uint64_t mib = 1024 * 1024;
    return pixels % mib == 0 ? std::to_string(pixels / mib) + " Mi"
                             : std::to_string(pixels);
  };
  switch (failure) {
  case DecodeFailure::None:
    return "";
  case DecodeFailure::UnsupportedFormat:
    return "unsupported format; expected PNG or JPEG";
  case DecodeFailure::CompressedInputLimit:
    return "compressed image exceeds 50 MiB limit";
  case DecodeFailure::InvalidHeader:
    return "invalid PNG or JPEG header";
  case DecodeFailure::DimensionLimit:
    return "image exceeds 16,384 pixel edge limit";
  case DecodeFailure::PixelLimit:
    return "image exceeds " + describePixels(imagePixelLimit) + " pixel limit";
  case DecodeFailure::JobPixelLimit:
    return "image exceeds remaining " + describePixels(jobPixelLimit) +
           " job pixel budget";
  case DecodeFailure::HighMemoryInputLimit:
    return "high-bit-depth PNG exceeds 64 MiB or CMYK JPEG exceeds 128 MiB "
           "source budget";
  case DecodeFailure::PngInflateLimit:
    return "PNG inflated data exceeds declared image size or is invalid";
  case DecodeFailure::JpegScanLimit:
    return "JPEG exceeds 32 scan limit";
  case DecodeFailure::InvalidData:
    return "invalid PNG or JPEG data";
  }
  return "invalid PNG or JPEG data";
}

void FreeDeleter::operator()(uint8_t* ptr) const noexcept {
  if (ptr != nullptr) {
    stbi_image_free(ptr);
  }
}

std::vector<uint8_t> encodeToPng(const sd_image_t& image) {
  std::vector<uint8_t> out;
  const auto [width, height, channel, data] = image;
  if (data == nullptr || width == 0 || height == 0 || channel == 0 ||
      channel > 4) {
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

  const int writeResult = stbi_write_png_to_func(
      writePngBytes,
      &out,
      static_cast<int>(width),
      static_cast<int>(height),
      static_cast<int>(channel),
      data,
      static_cast<int>(stride));
  if (writeResult == 0) {
    out.clear();
  }
  return out;
}

std::vector<uint8_t> encodeToJpeg(const sd_image_t& image, int quality) {
  std::vector<uint8_t> out;
  const auto [width, height, channel, data] = image;
  if (data == nullptr || width == 0 || height == 0 ||
      (channel != 1 && channel != 3) || quality < 1 || quality > 100) {
    return out;
  }
  if (width > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
      height > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
    return out;
  }

  const int writeResult = stbi_write_jpg_to_func(
      writePngBytes,
      &out,
      static_cast<int>(width),
      static_cast<int>(height),
      static_cast<int>(channel),
      data,
      quality);
  if (writeResult == 0) {
    out.clear();
  }
  return out;
}

sd_image_t decodeImage(
    const std::vector<uint8_t>& imageBytes, uint64_t pixelLimit,
    DecodeFailure* failure, uint64_t imagePixelLimit) {
  if (failure != nullptr) {
    *failure = DecodeFailure::None;
  }
  const auto reject = [failure](DecodeFailure reason) {
    if (failure != nullptr) {
      *failure = reason;
    }
    return sd_image_t{};
  };
  constexpr size_t maxCompressedBytes = 50ULL * 1024 * 1024;
  constexpr std::array<uint8_t, 8> pngSignature = {
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};
  const bool isPng =
      imageBytes.size() >= pngSignature.size() &&
      std::equal(pngSignature.begin(), pngSignature.end(), imageBytes.begin());
  const bool isJpeg = imageBytes.size() >= 3 && imageBytes[0] == 0xFF &&
                      imageBytes[1] == 0xD8 && imageBytes[2] == 0xFF;
  if (!isPng && !isJpeg) {
    return reject(DecodeFailure::UnsupportedFormat);
  }
  if (imageBytes.size() > maxCompressedBytes ||
      imageBytes.size() >
          static_cast<size_t>(std::numeric_limits<int>::max())) {
    return reject(DecodeFailure::CompressedInputLimit);
  }
  if (pixelLimit == 0) {
    return reject(DecodeFailure::JobPixelLimit);
  }

  int decodedWidth = 0;
  int decodedHeight = 0;
  int sourceChannels = 0;
  constexpr int desiredChannels = 3;
  const int inputSize = static_cast<int>(imageBytes.size());
  if (stbi_info_from_memory(
          imageBytes.data(),
          inputSize,
          &decodedWidth,
          &decodedHeight,
          &sourceChannels) == 0 ||
      decodedWidth <= 0 || decodedHeight <= 0 || sourceChannels <= 0) {
    return reject(DecodeFailure::InvalidHeader);
  }
  if (decodedWidth > STBI_MAX_DIMENSIONS ||
      decodedHeight > STBI_MAX_DIMENSIONS) {
    return reject(DecodeFailure::DimensionLimit);
  }
  const uint64_t pixels = static_cast<uint64_t>(decodedWidth) * decodedHeight;
  if (pixels > imagePixelLimit) {
    return reject(DecodeFailure::PixelLimit);
  }
  if (pixels > pixelLimit) {
    return reject(DecodeFailure::JobPixelLimit);
  }
  DecodeFailure preflightFailure = DecodeFailure::InvalidData;
  if (isPng ? !validatePngInflate(
                  imageBytes,
                  decodedWidth,
                  decodedHeight,
                  sourceChannels,
                  preflightFailure)
            : !validateJpegScans(imageBytes, pixels, preflightFailure)) {
    return reject(preflightFailure);
  }

  int loadedWidth = 0;
  int loadedHeight = 0;
  // clang-analyzer can miss that decodedData owns and releases STB memory.
  // NOLINTNEXTLINE(clang-analyzer-unix.Malloc)
  std::unique_ptr<uint8_t, FreeDeleter> decodedData(stbi_load_from_memory(
      imageBytes.data(),
      inputSize,
      &loadedWidth,
      &loadedHeight,
      &sourceChannels,
      desiredChannels));
  if (decodedData == nullptr || loadedWidth != decodedWidth ||
      loadedHeight != decodedHeight) {
    return reject(DecodeFailure::InvalidData);
  }

  return sd_image_t{
      static_cast<uint32_t>(decodedWidth),
      static_cast<uint32_t>(decodedHeight),
      static_cast<uint32_t>(desiredChannels),
      decodedData.release()};
}

} // namespace image_codec

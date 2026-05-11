#include "ImageCodec.hpp"

#include <algorithm>
#include <iterator>
#include <limits>
#include <memory>

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

// STB requires this exact C callback shape for stbi_write_png_to_func.
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

sd_image_t decodeImage(const std::vector<uint8_t>& imageBytes) {
  if (imageBytes.empty() ||
      imageBytes.size() >
          static_cast<size_t>(std::numeric_limits<int>::max())) {
    return sd_image_t{};
  }

  int decodedWidth = 0;
  int decodedHeight = 0;
  int sourceChannels = 0;
  constexpr int desiredChannels = 3;

  // clang-analyzer can miss that decodedData owns and releases STB memory.
  // NOLINTNEXTLINE(clang-analyzer-unix.Malloc)
  std::unique_ptr<uint8_t, FreeDeleter> decodedData(stbi_load_from_memory(
      imageBytes.data(),
      static_cast<int>(imageBytes.size()),
      &decodedWidth,
      &decodedHeight,
      &sourceChannels,
      desiredChannels));
  if (decodedData == nullptr || decodedWidth <= 0 || decodedHeight <= 0) {
    return sd_image_t{};
  }

  return sd_image_t{
      static_cast<uint32_t>(decodedWidth),
      static_cast<uint32_t>(decodedHeight),
      static_cast<uint32_t>(desiredChannels),
      decodedData.release()};
}

} // namespace image_codec

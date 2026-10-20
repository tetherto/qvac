#pragma once

#include <memory>
#include <string>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>

#include "ImageCodec.hpp"

namespace qvac_lib_inference_addon_sd {

struct ReferenceImagesDeleter {
  void operator()(std::vector<sd_image_t>* images) const noexcept {
    if (images == nullptr)
      return;
    for (const auto& image : *images)
      image_codec::FreeDeleter{}(image.data);
    delete images;
  }
};

using ReferenceImages =
    std::unique_ptr<std::vector<sd_image_t>, ReferenceImagesDeleter>;

// Own decoded buffers, including partial results when a later reference fails.
// The caller validates model capabilities before decoding any references.
inline ReferenceImages decodeReferenceImages(
    const std::vector<std::vector<uint8_t>>& encoded, uint64_t imagePixelLimit,
    uint64_t jobPixelLimit, image_codec::DecodeChannels channels) {
  ReferenceImages images(new std::vector<sd_image_t>());
  images->reserve(encoded.size());
  uint64_t decodedPixels = 0;
  for (size_t i = 0; i < encoded.size(); ++i) {
    if (encoded[i].empty())
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "img2img: init_images[" + std::to_string(i) +
              "] is empty -- every reference must be a non-empty PNG/JPEG "
              "buffer.");

    image_codec::DecodeFailure failure;
    auto decoded = image_codec::decodeImage(
        encoded[i],
        jobPixelLimit - decodedPixels,
        &failure,
        imagePixelLimit,
        channels);
    if (decoded.data == nullptr)
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "img2img: failed to decode init_images[" + std::to_string(i) + "]: " +
              image_codec::decodeFailureMessage(
                  failure, imagePixelLimit, jobPixelLimit));

    std::unique_ptr<uint8_t, image_codec::FreeDeleter> owned(decoded.data);
    images->push_back(decoded);
    owned.release();
    decodedPixels += static_cast<uint64_t>(decoded.width) * decoded.height;
  }
  return images;
}

} // namespace qvac_lib_inference_addon_sd

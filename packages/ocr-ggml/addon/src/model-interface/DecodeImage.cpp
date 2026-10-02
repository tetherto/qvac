#include "DecodeImage.hpp"

#include <limits>
#include <stdexcept>
#include <string>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

namespace qvac_lib_infer_ocr_ggml {

cv::Mat decodeOrWrapImage(const OcrInput& input) {
  if (input.isEncoded) {
    if (input.data.empty()) {
      throw std::runtime_error("ocr-ggml: encoded image is empty");
    }
    // cv::Mat constructor wants non-const void* but cv::imdecode does not
    // write through it. Reject lengths that would truncate when cast to int,
    // the same class of attacker-controlled size field as the NMT n_dims
    // overflow.
    if (input.data.size() >
        static_cast<size_t>(std::numeric_limits<int>::max())) {
      throw std::runtime_error("ocr-ggml: encoded image is too large");
    }
    cv::Mat encoded(
        1,
        static_cast<int>(input.data.size()),
        CV_8UC1,
        const_cast<uint8_t*>( // NOLINT(cppcoreguidelines-pro-type-const-cast)
            input.data.data()));
    cv::Mat decoded = cv::imdecode(encoded, cv::IMREAD_COLOR);
    if (decoded.empty()) {
      throw std::runtime_error(
          "ocr-ggml: failed to decode image (unsupported "
          "format or corrupt data)");
    }
    // cv::imdecode returns BGR; the OCR pre-processing expects RGB.
    cv::cvtColor(decoded, decoded, cv::COLOR_BGR2RGB);
    return decoded;
  }

  if (input.imageWidth <= 0 || input.imageHeight <= 0 || input.data.empty()) {
    throw std::runtime_error(
        "ocr-ggml: raw image input requires positive width/height and data");
  }

  int matType = 0;
  int expectedBytesPerPixel = 0;
  // NOLINTBEGIN(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  switch (input.bitsPerPixel) {
  case 8:
    matType = CV_8UC1;
    expectedBytesPerPixel = 1;
    break;
  case 24:
    matType = CV_8UC3;
    expectedBytesPerPixel = 3;
    break;
  case 32:
    matType = CV_8UC4;
    expectedBytesPerPixel = 4;
    break;
  default:
    throw std::runtime_error(
        "ocr-ggml: unsupported raw image bitsPerPixel " +
        std::to_string(input.bitsPerPixel) +
        " (only 8 / 24 / 32 are supported)");
  }
  // NOLINTEND(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)

  const uint64_t width = static_cast<uint64_t>(input.imageWidth);
  const uint64_t height = static_cast<uint64_t>(input.imageHeight);
  const uint64_t bpp = static_cast<uint64_t>(expectedBytesPerPixel);
  if (height > 0 && width > std::numeric_limits<size_t>::max() / height) {
    throw std::runtime_error("ocr-ggml: raw image dimensions overflow");
  }
  const uint64_t pixels = width * height;
  if (bpp > 0 && pixels > std::numeric_limits<size_t>::max() / bpp) {
    throw std::runtime_error("ocr-ggml: raw image dimensions overflow");
  }
  const size_t expectedBytes = static_cast<size_t>(pixels * bpp);
  if (input.data.size() != expectedBytes) {
    throw std::runtime_error(
        "ocr-ggml: raw image data size mismatch (expected " +
        std::to_string(expectedBytes) + " bytes for " +
        std::to_string(input.imageWidth) + "x" +
        std::to_string(input.imageHeight) + " @ " +
        std::to_string(input.bitsPerPixel) + "bpp, got " +
        std::to_string(input.data.size()) + ")");
  }

  // Wrap as a non-owning cv::Mat. OcrInput is passed by const& through
  // Pipeline::process and lives for the synchronous duration of processImage,
  // so this view is safe to use until processImage returns.
  cv::Mat raw(
      input.imageHeight,
      input.imageWidth,
      matType,
      const_cast<uint8_t*>( // NOLINT(cppcoreguidelines-pro-type-const-cast)
          input.data.data()));

  // Normalise to a 3-channel image; downstream steps expect CV_8UC3.
  // 24bpp is the historical fast path — pass through unchanged.
  if (matType == CV_8UC3) {
    return raw;
  }
  cv::Mat rgb;
  if (matType == CV_8UC1) {
    cv::cvtColor(raw, rgb, cv::COLOR_GRAY2RGB);
  } else { // CV_8UC4
    cv::cvtColor(raw, rgb, cv::COLOR_BGRA2RGB);
  }
  return rgb;
}

} // namespace qvac_lib_infer_ocr_ggml

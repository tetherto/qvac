#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>
#include <opencv2/imgcodecs.hpp>

#include "DecodeImage.hpp"

// Property tests over decodeOrWrapImage, the OCR addon's untrusted-input
// front door. Encoded JPEG/PNG bytes and raw bitmaps with attacker-controlled
// width/height/bpp must not crash, overflow the size check, or wrap the
// cv::Mat int cast. Same length-field class as the NMT n_dims overflow.
// See docs/architecture/ADDON-FUZZING.md.

namespace {

using qvac_lib_infer_ocr_ggml::decodeOrWrapImage;
using qvac_lib_infer_ocr_ggml::OcrInput;

std::vector<uint8_t> validPngSeed() {
  const cv::Mat rgb(16, 16, CV_8UC3, cv::Scalar(0, 128, 255));
  std::vector<uint8_t> encoded;
  if (!cv::imencode(".png", rgb, encoded) || encoded.empty()) {
    throw std::runtime_error(
        "ocr-decode-image-fuzz: failed to encode PNG seed");
  }
  return encoded;
}

OcrInput encodedInput(std::vector<uint8_t> bytes) {
  OcrInput input;
  input.isEncoded = true;
  input.data = std::move(bytes);
  return input;
}

OcrInput rawInput(int width, int height, int bpp, std::vector<uint8_t> bytes) {
  OcrInput input;
  input.isEncoded = false;
  input.imageWidth = width;
  input.imageHeight = height;
  input.bitsPerPixel = bpp;
  input.data = std::move(bytes);
  return input;
}

void EncodedNeverCrashes(const std::vector<uint8_t>& bytes) {
  try {
    (void)decodeOrWrapImage(encodedInput(bytes));
  } catch (const std::exception&) {
    // Rejected as invalid — including OpenCV's cv::Exception. Not a defect
    // for this NeverCrashes property; ASan abort is the finding.
  }
}

FUZZ_TEST(OcrDecodeImageFuzz, EncodedNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::vector<uint8_t>>().WithMaxSize(512))
    .WithSeeds([] {
      return std::vector<std::tuple<std::vector<uint8_t>>>{
          {validPngSeed()},
          {std::vector<uint8_t>{}},
          {std::vector<uint8_t>(16, 0)},
      };
    });

void RawNeverCrashes(
    int width, int height, int bitsPerPixel,
    const std::vector<uint8_t>& bytes) {
  try {
    (void)decodeOrWrapImage(rawInput(width, height, bitsPerPixel, bytes));
  } catch (const std::exception&) {
    // Rejected as invalid — including OpenCV's cv::Exception. Not a defect
    // for this NeverCrashes property; ASan abort is the finding.
  }
}

FUZZ_TEST(OcrDecodeImageFuzz, RawNeverCrashes)
    .WithDomains(
        fuzztest::InRange<int>(-1, 64), fuzztest::InRange<int>(-1, 64),
        fuzztest::ElementOf({0, 8, 16, 24, 32, 48}),
        fuzztest::Arbitrary<std::vector<uint8_t>>().WithMaxSize(256))
    .WithSeeds([] {
      return std::vector<std::tuple<int, int, int, std::vector<uint8_t>>>{
          {1, 1, 24, std::vector<uint8_t>{0, 0, 0}},
          {2, 2, 8, std::vector<uint8_t>(4, 128)},
          {1, 1, 32, std::vector<uint8_t>{0, 0, 0, 255}},
          {0, 1, 24, std::vector<uint8_t>{0, 0, 0}},
          {1, 1, 16, std::vector<uint8_t>{0, 0}},
      };
    });

using qvac_lib_infer_ocr_ggml::detail::checkedEncodedImageLength;
using qvac_lib_infer_ocr_ggml::detail::checkedRawImageByteCount;

TEST(OcrDecodeImageSizeGuards, EncodedLengthBoundaries) {
  const auto intMax = static_cast<size_t>(std::numeric_limits<int>::max());
  EXPECT_THROW(checkedEncodedImageLength(0), std::runtime_error);
  EXPECT_EQ(checkedEncodedImageLength(1), 1);
  EXPECT_EQ(
      checkedEncodedImageLength(intMax - 1),
      std::numeric_limits<int>::max() - 1);
  EXPECT_EQ(checkedEncodedImageLength(intMax), std::numeric_limits<int>::max());
  EXPECT_THROW(checkedEncodedImageLength(intMax + 1), std::runtime_error);
}

TEST(OcrDecodeImageSizeGuards, RawDimensionsMustBePositive) {
  EXPECT_THROW(checkedRawImageByteCount(0, 1, 1), std::runtime_error);
  EXPECT_THROW(checkedRawImageByteCount(1, -1, 1), std::runtime_error);
  EXPECT_THROW(checkedRawImageByteCount(1, 1, 0), std::runtime_error);
}

TEST(OcrDecodeImageSizeGuards, RawPixelCountAt32BitLimit) {
  const auto limit = static_cast<size_t>(std::numeric_limits<uint32_t>::max());
  // 65535 * 65537 is exactly UINT32_MAX; the adjacent square exceeds it.
  EXPECT_EQ(checkedRawImageByteCount(65535, 65537, 1, limit), limit);
  EXPECT_THROW(
      checkedRawImageByteCount(65536, 65536, 1, limit), std::runtime_error);
}

TEST(OcrDecodeImageSizeGuards, RawByteCountAt32BitLimit) {
  const auto limit = static_cast<size_t>(std::numeric_limits<uint32_t>::max());
  // The pixel count fits, but multiplying by four crosses the byte limit.
  EXPECT_EQ(
      checkedRawImageByteCount(65536, 16383, 4, limit), size_t{4294705152ULL});
  EXPECT_THROW(
      checkedRawImageByteCount(65536, 16384, 4, limit), std::runtime_error);
  EXPECT_EQ(checkedRawImageByteCount(1, 1, 4, 4), size_t{4});
  EXPECT_THROW(checkedRawImageByteCount(1, 1, 4, 3), std::runtime_error);
}

TEST(OcrDecodeImageSizeGuards, RawMaximumIntDimensionsAtHostLimit) {
  const int intMax = std::numeric_limits<int>::max();
  const auto byteCount =
      static_cast<uint64_t>(intMax) * static_cast<uint64_t>(intMax) * 4;
  if (byteCount <= std::numeric_limits<size_t>::max()) {
    EXPECT_EQ(
        checkedRawImageByteCount(intMax, intMax, 4),
        static_cast<size_t>(byteCount));
  } else {
    EXPECT_THROW(
        checkedRawImageByteCount(intMax, intMax, 4), std::runtime_error);
  }
}

TEST(OcrDecodeImageFuzzSeeds, ValidPngDecodesToRgb) {
  cv::Mat decoded;
  ASSERT_NO_THROW(decoded = decodeOrWrapImage(encodedInput(validPngSeed())));
  EXPECT_FALSE(decoded.empty());
  EXPECT_EQ(decoded.type(), CV_8UC3);
  EXPECT_EQ(decoded.cols, 16);
  EXPECT_EQ(decoded.rows, 16);
}

TEST(OcrDecodeImageFuzzSeeds, RawSizeMismatchIsRejected) {
  EXPECT_THROW(
      decodeOrWrapImage(rawInput(8, 8, 24, std::vector<uint8_t>(3, 0))),
      std::runtime_error);
}

TEST(OcrDecodeImageFuzzSeeds, EmptyEncodedIsRejected) {
  EXPECT_THROW(decodeOrWrapImage(encodedInput({})), std::runtime_error);
}

} // namespace

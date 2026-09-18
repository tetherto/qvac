#include <cstdint>
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
    throw std::runtime_error("ocr-decode-image-fuzz: failed to encode PNG seed");
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
  } catch (const std::runtime_error&) {
    // Rejected as invalid — not a defect.
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
    int width, int height, int bitsPerPixel, const std::vector<uint8_t>& bytes) {
  try {
    (void)decodeOrWrapImage(rawInput(width, height, bitsPerPixel, bytes));
  } catch (const std::runtime_error&) {
    // Rejected as invalid — not a defect.
  }
}

FUZZ_TEST(OcrDecodeImageFuzz, RawNeverCrashes)
    .WithDomains(
        fuzztest::InRange<int>(-1, 64),
        fuzztest::InRange<int>(-1, 64),
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

} // namespace

#include <gtest/gtest.h>

#include "model-interface/ImagePreprocessor.hpp"

using namespace qvac_lib_infer_ggml_classification::preprocess;

TEST(PreprocessorTest, MagicBytesDetectJpeg) {
  const std::array<uint8_t, 4> jpeg = {0xFF, 0xD8, 0xFF, 0xE0};
  EXPECT_TRUE(isEncodedImage({jpeg.data(), jpeg.size()}));
}

TEST(PreprocessorTest, MagicBytesDetectPng) {
  const std::array<uint8_t, 8> png = {
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};
  EXPECT_TRUE(isEncodedImage({png.data(), png.size()}));
}

TEST(PreprocessorTest, MagicBytesRejectBmp) {
  const std::array<uint8_t, 4> bmp = {0x42, 0x4D, 0x00, 0x00};
  EXPECT_FALSE(isEncodedImage({bmp.data(), bmp.size()}));
}

TEST(PreprocessorTest, ValidateRawRgbChecksChannelCount) {
  std::vector<uint8_t> buf(4 * 4 * 4, 0);
  EXPECT_THROW(validateRawRgb(buf, 4, 4, 4), std::exception);
}

TEST(PreprocessorTest, ValidateRawRgbChecksBufferSize) {
  std::vector<uint8_t> buf(5, 0);
  EXPECT_THROW(validateRawRgb(buf, 4, 4, 3), std::exception);
}

TEST(PreprocessorTest, ValidateRawRgbAccepts3Channels) {
  std::vector<uint8_t> buf(4 * 4 * 3, 0);
  EXPECT_NO_THROW(validateRawRgb(buf, 4, 4, 3));
}

TEST(PreprocessorTest, EmptyBufferIsRejected) {
  std::vector<uint8_t> buf;
  EXPECT_THROW(preprocessToTensor(buf, 0, 0, 0), std::exception);
}

TEST(PreprocessorTest, NormalizeToWhcnProducesExpectedSize) {
  std::vector<uint8_t> rgb(kInputSize * kInputSize * kChannels, 128);
  std::vector<float> out = normalizeToWhcn(rgb);
  EXPECT_EQ(out.size(),
            static_cast<size_t>(kInputSize) * kInputSize * kChannels);
  // Pixel value 128/255 is close to 0.502; subtracting ImageNet means and
  // dividing by std should produce values well inside [-3, 3] for all
  // channels.
  for (float v : out) {
    EXPECT_GT(v, -3.0F);
    EXPECT_LT(v, 3.0F);
  }
}

TEST(PreprocessorTest, ResizeProducesExpectedDimensions) {
  std::vector<uint8_t> src(10 * 10 * 3, 200);
  std::vector<uint8_t> resized = resizeToInput(src, 10, 10);
  EXPECT_EQ(resized.size(),
            static_cast<size_t>(kInputSize) * kInputSize * kChannels);
}

TEST(PreprocessorTest, NormalizeToWhcnChannelFirstLayout) {
  // Fill plane with (255, 0, 0) red; verify R channel first, then G, then B.
  std::vector<uint8_t> rgb(kInputSize * kInputSize * kChannels, 0);
  for (size_t i = 0; i < static_cast<size_t>(kInputSize) * kInputSize; ++i) {
    rgb[i * 3 + 0] = 255; // R
  }
  std::vector<float> out = normalizeToWhcn(rgb);
  const size_t plane = static_cast<size_t>(kInputSize) * kInputSize;
  // R channel plane: normalized (1.0 - 0.485) / 0.229 ≈ 2.248
  EXPECT_NEAR(out[0], (1.0F - kImageNetMean[0]) / kImageNetStd[0], 1e-3F);
  // G channel plane (offset = plane) starts from 0.
  EXPECT_NEAR(out[plane], (0.0F - kImageNetMean[1]) / kImageNetStd[1], 1e-3F);
  // B channel plane (offset = 2*plane) starts from 0.
  EXPECT_NEAR(out[2 * plane], (0.0F - kImageNetMean[2]) / kImageNetStd[2], 1e-3F);
}

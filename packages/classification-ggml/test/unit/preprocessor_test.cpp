#include <gtest/gtest.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <vector>

#include "model-interface/ImagePreprocessor.hpp"

using namespace qvac_lib_infer_ggml_classification::preprocess;

namespace {

// Walks up from the current working directory looking for the given
// repo-relative test image. Mirrors the pattern in
// classification_model_test.cpp::findWeightsPath().
std::vector<uint8_t> readTestImage(const std::string& name) {
  std::filesystem::path here = std::filesystem::current_path();
  for (int i = 0; i < 6; ++i) {
    const auto candidate = here / "test" / "images" / name;
    if (std::filesystem::exists(candidate)) {
      std::ifstream f(candidate, std::ios::binary);
      f.seekg(0, std::ios::end);
      const std::streamsize size = f.tellg();
      f.seekg(0, std::ios::beg);
      std::vector<uint8_t> buf(static_cast<size_t>(size));
      f.read(reinterpret_cast<char*>(buf.data()), size);
      return buf;
    }
    if (!here.has_parent_path()) break;
    here = here.parent_path();
  }
  return {};
}

} // namespace

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

// -------- decodeToRgb coverage --------

TEST(PreprocessorTest, DecodeToRgbDecodesValidJpeg) {
  std::vector<uint8_t> jpeg = readTestImage("meal_1.jpg");
  if (jpeg.empty()) {
    GTEST_SKIP() << "test/images/meal_1.jpg not found; skipping.";
  }
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> rgb = decodeToRgb(jpeg, width, height);
  EXPECT_GT(width, 0u);
  EXPECT_GT(height, 0u);
  EXPECT_LE(width, kMaxImageDimension);
  EXPECT_LE(height, kMaxImageDimension);
  EXPECT_EQ(
      rgb.size(),
      static_cast<size_t>(width) * height * kChannels);
}

TEST(PreprocessorTest, DecodeToRgbRejectsEmptyBuffer) {
  std::vector<uint8_t> empty;
  uint32_t w = 0;
  uint32_t h = 0;
  EXPECT_THROW(decodeToRgb(empty, w, h), std::exception);
}

TEST(PreprocessorTest, DecodeToRgbRejectsCorruptedBytes) {
  // 16 random bytes that do not parse as any image format.
  std::vector<uint8_t> garbage = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
                                  0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E,
                                  0x0F, 0x10};
  uint32_t w = 0;
  uint32_t h = 0;
  EXPECT_THROW(decodeToRgb(garbage, w, h), std::exception);
}

TEST(PreprocessorTest, DecodeToRgbRejectsTruncatedJpeg) {
  std::vector<uint8_t> jpeg = readTestImage("meal_1.jpg");
  if (jpeg.empty()) {
    GTEST_SKIP() << "test/images/meal_1.jpg not found; skipping.";
  }
  // Drop everything past the SOI + a handful of header bytes; stbi must
  // reject the resulting truncated stream rather than silently producing
  // a partial image.
  jpeg.resize(8);
  uint32_t w = 0;
  uint32_t h = 0;
  EXPECT_THROW(decodeToRgb(jpeg, w, h), std::exception);
}

// -------- preprocessToTensor full-pipeline coverage --------

TEST(PreprocessorTest, PreprocessToTensorAcceptsEncodedJpeg) {
  std::vector<uint8_t> jpeg = readTestImage("meal_1.jpg");
  if (jpeg.empty()) {
    GTEST_SKIP() << "test/images/meal_1.jpg not found; skipping.";
  }
  std::vector<float> out = preprocessToTensor(jpeg, 0, 0, 0);
  EXPECT_EQ(
      out.size(),
      static_cast<size_t>(kInputSize) * kInputSize * kChannels);
  for (float v : out) {
    EXPECT_TRUE(std::isfinite(v));
  }
}

TEST(PreprocessorTest, PreprocessToTensorAcceptsRawRgb) {
  // 16x16 raw RGB block, every channel = 64.
  constexpr uint32_t kSide = 16;
  std::vector<uint8_t> raw(
      static_cast<size_t>(kSide) * kSide * kChannels, 64);
  std::vector<float> out = preprocessToTensor(raw, kSide, kSide, kChannels);
  EXPECT_EQ(
      out.size(),
      static_cast<size_t>(kInputSize) * kInputSize * kChannels);
  for (float v : out) {
    EXPECT_TRUE(std::isfinite(v));
  }
}

TEST(PreprocessorTest, PreprocessToTensorRejectsBmpWithoutDimensions) {
  // BMP header magic + a few padding bytes; treated as encoded (no
  // declared dims) -> must reject because BMP is not a supported
  // encoded format.
  std::vector<uint8_t> bmp = {0x42, 0x4D, 0x46, 0x00, 0x00, 0x00,
                              0x00, 0x00, 0x00, 0x00};
  EXPECT_THROW(preprocessToTensor(bmp, 0, 0, 0), std::exception);
}

TEST(PreprocessorTest, PreprocessToTensorRejectsRawWithMissingDims) {
  // Sized like a 4x4 RGB buffer but channels not declared -> caller
  // must pass width/height/channels for the raw path.
  std::vector<uint8_t> raw(4 * 4 * 3, 0);
  EXPECT_THROW(preprocessToTensor(raw, 0, 0, 0), std::exception);
}

// -------- validateRawRgb edge cases --------

TEST(PreprocessorTest, ValidateRawRgbRejectsEmptyBuffer) {
  std::vector<uint8_t> empty;
  EXPECT_THROW(validateRawRgb(empty, 4, 4, 3), std::exception);
}

TEST(PreprocessorTest, ValidateRawRgbRejectsZeroWidth) {
  std::vector<uint8_t> buf(4 * 3, 0);
  EXPECT_THROW(validateRawRgb(buf, 0, 4, 3), std::exception);
}

TEST(PreprocessorTest, ValidateRawRgbRejectsZeroHeight) {
  std::vector<uint8_t> buf(4 * 3, 0);
  EXPECT_THROW(validateRawRgb(buf, 4, 0, 3), std::exception);
}

TEST(PreprocessorTest, ValidateRawRgbRejectsOverKMaxImageDimensionWidth) {
  // We do not allocate the full buffer (just enough to satisfy the
  // size check that runs after the dimension check); dimension check
  // must reject before any other validation.
  std::vector<uint8_t> buf(8, 0);
  EXPECT_THROW(
      validateRawRgb(buf, kMaxImageDimension + 1, 1, 3), std::exception);
}

TEST(PreprocessorTest, ValidateRawRgbRejectsOverKMaxImageDimensionHeight) {
  std::vector<uint8_t> buf(8, 0);
  EXPECT_THROW(
      validateRawRgb(buf, 1, kMaxImageDimension + 1, 3), std::exception);
}

// -------- normalizeToWhcn invalid input size --------

TEST(PreprocessorTest, NormalizeToWhcnRejectsWrongInputSize) {
  // One byte short of the expected (kInputSize^2 * kChannels) buffer.
  std::vector<uint8_t> buf(
      static_cast<size_t>(kInputSize) * kInputSize * kChannels - 1, 0);
  EXPECT_THROW(normalizeToWhcn(buf), std::exception);
}

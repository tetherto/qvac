#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/ImagePixelLimit.hpp"
#include "model-interface/MultimodalEmbedder.hpp"

namespace {
using Config = std::unordered_map<std::string, std::string>;

// A BMP header that declares width x height, enough for stb_image's info call.
std::vector<uint8_t> bmpHeader(int32_t width, int32_t height) {
  std::vector<uint8_t> buf(54, 0);
  auto put32 = [&buf](size_t off, uint32_t v) {
    for (size_t i = 0; i < 4; ++i) {
      buf[off + i] = static_cast<uint8_t>(v >> (8 * i));
    }
  };
  buf[0] = 'B';
  buf[1] = 'M';
  put32(2, 54);
  put32(10, 54);
  put32(14, 40);
  put32(18, static_cast<uint32_t>(width));
  put32(22, static_cast<uint32_t>(height));
  buf[26] = 1;  // planes
  buf[28] = 24; // bits per pixel
  return buf;
}
} // namespace

TEST(MultimodalOptionsTest, DefaultsWhenUnset) {
  Config config{{"device", "gpu"}};
  const MultimodalOptions options = takeMultimodalOptions(config);
  EXPECT_EQ(options.imageMinTokens, -1);
  EXPECT_EQ(options.imageMaxTokens, -1);
  EXPECT_FALSE(options.noAudio);
  EXPECT_FALSE(options.useGpu.has_value());
  EXPECT_EQ(options.maxImagePixels, image_pixel_limit::DEFAULT_MAX_PIXELS);
  EXPECT_EQ(config.size(), 1U);
}

TEST(MultimodalOptionsTest, ReadsAndErasesEveryKey) {
  Config config{
      {"device", "gpu"},
      {"image-min-tokens", "70"},
      {"image_max_tokens", "280"},
      {"mmproj-no-audio", "on"},
      {"mmproj_use_gpu", "FALSE"},
      {"image-max-megapixels", "8"}};
  const MultimodalOptions options = takeMultimodalOptions(config);
  EXPECT_EQ(options.imageMinTokens, 70);
  EXPECT_EQ(options.imageMaxTokens, 280);
  EXPECT_TRUE(options.noAudio);
  ASSERT_TRUE(options.useGpu.has_value());
  EXPECT_FALSE(*options.useGpu);
  EXPECT_EQ(options.maxImagePixels, 8'000'000U);
  // Only the keys llama.cpp's parser accepts are left.
  EXPECT_EQ(config, (Config{{"device", "gpu"}}));
}

TEST(MultimodalOptionsTest, RejectsInvalidValues) {
  for (const Config& bad :
       {Config{{"image-max-tokens", "0"}},
        Config{{"image-max-tokens", "12x"}},
        Config{{"image-min-tokens", "-5"}},
        Config{{"mmproj-no-audio", "maybe"}},
        Config{{"mmproj-use-gpu", ""}},
        Config{{"image-max-megapixels", "0"}},
        Config{{"image-min-tokens", "300"}, {"image-max-tokens", "280"}},
        Config{{"image-max-tokens", "280"}, {"image_max_tokens", "280"}}}) {
    Config config = bad;
    EXPECT_THROW(takeMultimodalOptions(config), qvac_errors::StatusError)
        << bad.begin()->first << "=" << bad.begin()->second;
  }
}

TEST(ImagePixelLimitTest, AcceptsAnImageWithinTheLimit) {
  const auto bmp = bmpHeader(1000, 1000);
  EXPECT_NO_THROW(
      image_pixel_limit::checkBuffer(bmp.data(), bmp.size(), 1'000'000));
}

TEST(ImagePixelLimitTest, RejectsALargerImageBeforeDecoding) {
  const auto bmp = bmpHeader(1001, 1000);
  EXPECT_THROW(
      image_pixel_limit::checkBuffer(bmp.data(), bmp.size(), 1'000'000),
      qvac_errors::StatusError);
}

TEST(ImagePixelLimitTest, AudioPasses) {
  std::vector<uint8_t> wav = {
      'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'};
  EXPECT_NO_THROW(image_pixel_limit::checkBuffer(wav.data(), wav.size(), 1));
}

TEST(ImagePixelLimitTest, RejectsAnImageOfUnknownSize) {
  // A WebP header: stb_image cannot read its size, and mtmd-helper would hand
  // it to ffmpeg unchecked.
  std::vector<uint8_t> webp = {
      'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P'};
  EXPECT_THROW(
      image_pixel_limit::checkBuffer(webp.data(), webp.size(), 1'000'000),
      qvac_errors::StatusError);
  EXPECT_THROW(
      image_pixel_limit::checkBuffer(nullptr, 0, 1'000'000),
      qvac_errors::StatusError);
}

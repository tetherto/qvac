#include <cstdint>
#include <limits>
#include <optional>
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
  const MultimodalOptions options = takeMultimodalOptions(config, true);
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
  const MultimodalOptions options = takeMultimodalOptions(config, true);
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
    EXPECT_THROW(takeMultimodalOptions(config, true), qvac_errors::StatusError)
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

TEST(ImagePixelLimitTest, MeasuresATopDownBmp) {
  // A top-down BMP (as macOS sips writes) stores a negative height.
  const auto bmp = bmpHeader(1000, -1000);
  EXPECT_NO_THROW(
      image_pixel_limit::checkBuffer(bmp.data(), bmp.size(), 1'000'000));
  const auto larger = bmpHeader(1001, -1000);
  EXPECT_THROW(
      image_pixel_limit::checkBuffer(larger.data(), larger.size(), 1'000'000),
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

TEST(MultimodalOptionsTest, ReadsTheAudioLimitOption) {
  Config config{{"audio-max-seconds", "30"}, {"device", "cpu"}};
  EXPECT_EQ(takeMultimodalOptions(config, true).maxAudioSeconds, 30U);
  EXPECT_EQ(config.size(), 1U);

  Config unset{};
  EXPECT_EQ(
      takeMultimodalOptions(unset, true).maxAudioSeconds,
      MultimodalOptions::DEFAULT_MAX_AUDIO_SECONDS);

  for (const char* bad : {"0", "-1", "ten", "1.5"}) {
    Config invalid{{"audio-max-seconds", bad}};
    EXPECT_THROW(takeMultimodalOptions(invalid, true), qvac_errors::StatusError)
        << bad;
  }
}

TEST(MultimodalOptionsTest, RejectsOptionsWithoutAProjectionModel) {
  // Each key alone: none of them does anything without a projection model.
  for (const char* key :
       {"image-max-tokens",
        "image_min_tokens",
        "mmproj-no-audio",
        "mmproj-use-gpu",
        "image-max-megapixels",
        "audio-max-seconds"}) {
    Config config{{key, "1"}, {"device", "gpu"}};
    EXPECT_THROW(takeMultimodalOptions(config, false), qvac_errors::StatusError)
        << key;
  }
}

TEST(MultimodalOptionsTest, LeavesATextOnlyConfigAlone) {
  Config config{{"device", "gpu"}, {"batch_size", "512"}};
  const MultimodalOptions options = takeMultimodalOptions(config, false);
  EXPECT_EQ(options.imageMaxTokens, -1);
  EXPECT_EQ(config, (Config{{"device", "gpu"}, {"batch_size", "512"}}));
}

TEST(MediaDecodeOptionsTest, CountsAudioAtTheModelRateWithOneFrameOfSlack) {
  const MediaLimits limits{.maxImagePixels = 8'000'000, .maxAudioSeconds = 30};
  const mtmd_helper_init_opt opt = mediaDecodeOptions(limits, 16000);
  EXPECT_EQ(opt.max_image_pixels, 8'000'000U);
  // miniaudio counts 16001 frames for 1 s of 48 kHz audio at 16 kHz.
  EXPECT_EQ(opt.max_audio_frames, 30U * 16000U + 1U);
}

TEST(MediaDecodeOptionsTest, SetsNoAudioLimitWithoutAnAudioEncoder) {
  const MediaLimits limits{.maxImagePixels = 8'000'000, .maxAudioSeconds = 30};
  for (const int rate : {-1, 0}) {
    const mtmd_helper_init_opt opt = mediaDecodeOptions(limits, rate);
    EXPECT_EQ(opt.max_audio_frames, 0U) << rate;
    EXPECT_EQ(opt.max_image_pixels, 8'000'000U) << rate;
  }
}

TEST(MediaDecodeOptionsTest, SaturatesInsteadOfWrapping) {
  // 0 means no limit to mtmd, so an overflowing value must not wrap to it.
  constexpr uint64_t maxFrames = std::numeric_limits<uint64_t>::max();
  constexpr int rate = 16000;
  const uint64_t largest = (maxFrames - 1) / rate;
  EXPECT_EQ(
      mediaDecodeOptions(
          {.maxImagePixels = 1, .maxAudioSeconds = largest}, rate)
          .max_audio_frames,
      largest * rate + 1);
  EXPECT_EQ(
      mediaDecodeOptions(
          {.maxImagePixels = 1, .maxAudioSeconds = largest + 1}, rate)
          .max_audio_frames,
      maxFrames);
}

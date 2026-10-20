#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/AudioLengthLimit.hpp"
#include "model-interface/ImagePixelLimit.hpp"
#include "model-interface/MultimodalEmbedder.hpp"

namespace {
using Config = std::unordered_map<std::string, std::string>;

void putLe(std::vector<uint8_t>& buf, size_t off, uint32_t v, size_t bytes) {
  for (size_t i = 0; i < bytes; ++i) {
    buf[off + i] = static_cast<uint8_t>(v >> (8 * i));
  }
}

// A PCM WAV header whose data chunk declares dataBytes; only `present`
// sample bytes follow it.
std::vector<uint8_t> wavHeader(
    uint32_t sampleRate, uint32_t channels, uint32_t dataBytes,
    size_t present = 0) {
  std::vector<uint8_t> buf(44 + present, 0);
  std::memcpy(buf.data(), "RIFF", 4);
  putLe(buf, 4, 36 + dataBytes, 4);
  std::memcpy(buf.data() + 8, "WAVEfmt ", 8);
  putLe(buf, 16, 16, 4);
  putLe(buf, 20, 1, 2); // PCM
  putLe(buf, 22, channels, 2);
  putLe(buf, 24, sampleRate, 4);
  putLe(buf, 28, sampleRate * channels * 2, 4);
  putLe(buf, 32, channels * 2, 2); // block align
  putLe(buf, 34, 16, 2);
  std::memcpy(buf.data() + 36, "data", 4);
  putLe(buf, 40, dataBytes, 4);
  return buf;
}

// "fLaC" and a STREAMINFO block declaring sampleRate and totalSamples.
std::vector<uint8_t> flacHeader(uint32_t sampleRate, uint64_t totalSamples) {
  std::vector<uint8_t> buf(8 + 34, 0);
  std::memcpy(buf.data(), "fLaC", 4);
  buf[4] = 0x80; // last block, STREAMINFO
  buf[7] = 34;
  uint8_t* info = buf.data() + 8;
  info[10] = static_cast<uint8_t>(sampleRate >> 12);
  info[11] = static_cast<uint8_t>(sampleRate >> 4);
  info[12] = static_cast<uint8_t>(((sampleRate & 0x0F) << 4) | (1 << 1));
  info[13] = static_cast<uint8_t>(0x70 | ((totalSamples >> 32) & 0x0F));
  info[14] = static_cast<uint8_t>(totalSamples >> 24);
  info[15] = static_cast<uint8_t>(totalSamples >> 16);
  info[16] = static_cast<uint8_t>(totalSamples >> 8);
  info[17] = static_cast<uint8_t>(totalSamples);
  return buf;
}

// `frames` MPEG-1 layer III frames at 128 kbps / 44.1 kHz (418 bytes each,
// no padding: 1152 samples), behind an ID3v2 tag when withId3.
std::vector<uint8_t> mp3Frames(size_t frames, bool withId3) {
  constexpr size_t kFrameBytes = 144 * 128000 / 44100; // 417
  std::vector<uint8_t> buf;
  if (withId3) {
    buf = {'I', 'D', '3', 4, 0, 0, 0, 0, 0, 20};
    buf.resize(buf.size() + 20, 0);
  }
  for (size_t i = 0; i < frames; ++i) {
    const size_t at = buf.size();
    buf.resize(at + kFrameBytes, 0);
    buf[at] = 0xFF;
    buf[at + 1] = 0xFB; // MPEG-1, layer III, no CRC
    buf[at + 2] = 0x90; // 128 kbps, 44.1 kHz, no padding
  }
  return buf;
}

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

TEST(AudioLengthLimitTest, ReadsWavLengthFromItsHeader) {
  // 16 kHz stereo, 2 s of 16-bit samples.
  const auto wav = wavHeader(16000, 2, 16000 * 2 * 2 * 2);
  const auto seconds =
      audio_length_limit::durationSeconds(wav.data(), wav.size());
  ASSERT_TRUE(seconds.has_value());
  EXPECT_DOUBLE_EQ(*seconds, 2.0);
}

TEST(AudioLengthLimitTest, RejectsAWavThatDeclaresMoreThanItHolds) {
  // 44 bytes that declare ~4 GB of samples: mtmd-helper would allocate the
  // declared length before reading any of it.
  const auto wav = wavHeader(8000, 1, 0xFFFFFFF0U);
  EXPECT_THROW(
      audio_length_limit::checkBuffer(wav.data(), wav.size(), 600),
      qvac_errors::StatusError);
}

TEST(AudioLengthLimitTest, ReadsFlacLengthFromStreamInfo) {
  const auto flac = flacHeader(48000, 48000ULL * 90);
  const auto seconds =
      audio_length_limit::durationSeconds(flac.data(), flac.size());
  ASSERT_TRUE(seconds.has_value());
  EXPECT_DOUBLE_EQ(*seconds, 90.0);
  EXPECT_NO_THROW(
      audio_length_limit::checkBuffer(flac.data(), flac.size(), 90));
  EXPECT_THROW(
      audio_length_limit::checkBuffer(flac.data(), flac.size(), 89),
      qvac_errors::StatusError);
}

TEST(AudioLengthLimitTest, RejectsFlacOfUnknownLength) {
  const auto flac = flacHeader(48000, 0);
  EXPECT_FALSE(audio_length_limit::durationSeconds(flac.data(), flac.size()));
  EXPECT_THROW(
      audio_length_limit::checkBuffer(flac.data(), flac.size(), 600),
      qvac_errors::StatusError);
}

TEST(AudioLengthLimitTest, CountsMp3FramesWithAndWithoutId3) {
  for (const bool withId3 : {false, true}) {
    const auto mp3 = mp3Frames(100, withId3);
    const auto seconds =
        audio_length_limit::durationSeconds(mp3.data(), mp3.size());
    ASSERT_TRUE(seconds.has_value());
    EXPECT_NEAR(*seconds, 100 * 1152.0 / 44100, 1e-9) << "id3=" << withId3;
  }
}

TEST(AudioLengthLimitTest, ReadsTheLimitOption) {
  Config config{{"audio-max-seconds", "30"}, {"device", "cpu"}};
  EXPECT_EQ(takeMultimodalOptions(config).maxAudioSeconds, 30U);
  EXPECT_EQ(config.size(), 1U);

  Config unset{};
  EXPECT_EQ(
      takeMultimodalOptions(unset).maxAudioSeconds,
      audio_length_limit::DEFAULT_MAX_SECONDS);

  for (const char* bad : {"0", "-1", "ten", "1.5"}) {
    Config invalid{{"audio-max-seconds", bad}};
    EXPECT_THROW(takeMultimodalOptions(invalid), qvac_errors::StatusError)
        << bad;
  }
}

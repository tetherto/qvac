#include <algorithm>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
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

// A RIFF WAV with the given fmt fields, an optional fact chunk, and a data
// chunk that declares dataBytes with `present` bytes after it.
struct WavSpec {
  uint16_t format = 1; // PCM
  uint16_t channels = 1;
  uint32_t sampleRate = 16000;
  uint16_t blockAlign = 2;
  uint16_t bitsPerSample = 16;
  std::optional<uint32_t> factFrames;
  uint32_t dataBytes = 0;
  size_t present = 0;
};

std::vector<uint8_t> wavFile(const WavSpec& w) {
  std::vector<uint8_t> buf(12 + 8 + 16, 0);
  std::memcpy(buf.data(), "RIFF", 4);
  std::memcpy(buf.data() + 8, "WAVEfmt ", 8);
  putLe(buf, 16, 16, 4);
  putLe(buf, 20, w.format, 2);
  putLe(buf, 22, w.channels, 2);
  putLe(buf, 24, w.sampleRate, 4);
  putLe(buf, 28, w.sampleRate * w.blockAlign, 4);
  putLe(buf, 32, w.blockAlign, 2);
  putLe(buf, 34, w.bitsPerSample, 2);
  if (w.factFrames.has_value()) {
    const size_t at = buf.size();
    buf.resize(at + 12, 0);
    std::memcpy(buf.data() + at, "fact", 4);
    putLe(buf, at + 4, 4, 4);
    putLe(buf, at + 8, *w.factFrames, 4);
  }
  const size_t at = buf.size();
  buf.resize(at + 8 + w.present, 0);
  std::memcpy(buf.data() + at, "data", 4);
  putLe(buf, at + 4, w.dataBytes, 4);
  putLe(buf, 4, static_cast<uint32_t>(buf.size() - 8), 4);
  return buf;
}

std::optional<double> lengthOf(const std::vector<uint8_t>& b) {
  return audio_length_limit::durationSeconds(b.data(), b.size());
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

TEST(AudioLengthLimitTest, ReadsWavLengthFromItsHeader) {
  // 16 kHz stereo, 2 s of 16-bit samples (present: miniaudio measures PCM by
  // the bytes it holds).
  const auto wav = wavHeader(16000, 2, 16000 * 2 * 2 * 2, 16000 * 2 * 2 * 2);
  const auto seconds =
      audio_length_limit::durationSeconds(wav.data(), wav.size());
  ASSERT_TRUE(seconds.has_value());
  EXPECT_DOUBLE_EQ(*seconds, 2.0);
}

TEST(AudioLengthLimitTest, MeasuresPcmWavByTheBytesItHolds) {
  // The memory decoder clamps a PCM data chunk to the bytes present, so one
  // that declares ~4 GB but holds 1 s is decoded as 1 s.
  const auto wav = wavFile({.dataBytes = 0xFFFFFFF0U, .present = 32000});
  const auto seconds = lengthOf(wav);
  ASSERT_TRUE(seconds.has_value());
  EXPECT_DOUBLE_EQ(*seconds, 1.0);
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
  EXPECT_EQ(takeMultimodalOptions(config, true).maxAudioSeconds, 30U);
  EXPECT_EQ(config.size(), 1U);

  Config unset{};
  EXPECT_EQ(
      takeMultimodalOptions(unset, true).maxAudioSeconds,
      audio_length_limit::DEFAULT_MAX_SECONDS);

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

TEST(AudioLengthLimitTest, RejectsMp3WithFreeFormatFrames) {
  // One normal frame, then a free-format header (bitrate index 0): minimp3
  // decodes such frames, so the length cannot be counted from the headers.
  auto mp3 = mp3Frames(1, false);
  const size_t at = mp3.size();
  mp3.resize(at + 512, 0);
  mp3[at] = 0xFF;
  mp3[at + 1] = 0xFB;
  mp3[at + 2] = 0x00; // free format, 44.1 kHz
  EXPECT_FALSE(audio_length_limit::durationSeconds(mp3.data(), mp3.size()));
  EXPECT_THROW(
      audio_length_limit::checkBuffer(mp3.data(), mp3.size(), 600),
      qvac_errors::StatusError);
}

// The shapes below are each one where miniaudio's length is larger than the
// file suggests; each must be measured as miniaudio measures it.

TEST(AudioLengthLimitTest, UsesDrWavBytesPerFrameNotBlockAlign) {
  // 8-bit mono at 1 Hz: dr_wav's frame is 1 byte whatever blockAlign says,
  // so 1000 bytes are 1000 s (resampled to the model's rate on decode).
  const auto wav = wavFile(
      {.sampleRate = 1,
       .blockAlign = 65535,
       .bitsPerSample = 8,
       .dataBytes = 1000,
       .present = 1000});
  const auto seconds = lengthOf(wav);
  ASSERT_TRUE(seconds.has_value());
  EXPECT_DOUBLE_EQ(*seconds, 1000.0);
  EXPECT_THROW(
      audio_length_limit::checkBuffer(wav.data(), wav.size(), 600),
      qvac_errors::StatusError);
}

TEST(AudioLengthLimitTest, UsesAnAdpcmFactCount) {
  // MS ADPCM: dr_wav takes the fact chunk's sample count, which the file
  // size does not bound.
  const auto wav = wavFile(
      {.format = 0x0002,
       .blockAlign = 256,
       .bitsPerSample = 4,
       .factFrames = 0xFFFFFF00U,
       .dataBytes = 256,
       .present = 256});
  const auto seconds = lengthOf(wav);
  ASSERT_TRUE(seconds.has_value());
  EXPECT_GT(*seconds, 600.0);
}

TEST(AudioLengthLimitTest, KeepsDrWavsAdpcmArithmetic) {
  // Blocks shorter than their headers wrap dr_wav's unsigned formula to a
  // huge count: it must be measured (and rejected), not treated as empty.
  const auto wav = wavFile(
      {.format = 0x0011,
       .channels = 2,
       .blockAlign = 4,
       .bitsPerSample = 4,
       .dataBytes = 64,
       .present = 64});
  const auto seconds = lengthOf(wav);
  ASSERT_TRUE(seconds.has_value());
  EXPECT_GT(*seconds, 600.0);
}

TEST(AudioLengthLimitTest, RejectsWhatDrWavRejects) {
  // ma_decoder would go on to read these bytes as MP3.
  for (const WavSpec& bad :
       {WavSpec{.channels = 0, .dataBytes = 2, .present = 2},
        WavSpec{.sampleRate = 0, .dataBytes = 2, .present = 2},
        WavSpec{.blockAlign = 0, .dataBytes = 2, .present = 2},
        WavSpec{.bitsPerSample = 0, .dataBytes = 2, .present = 2},
        WavSpec{
            .format = 0x0002,
            .channels = 3,
            .blockAlign = 256,
            .bitsPerSample = 4,
            .dataBytes = 256,
            .present = 256}}) {
    const auto wav = wavFile(bad);
    EXPECT_FALSE(lengthOf(wav).has_value());
  }
}

TEST(AudioLengthLimitTest, UsesAnMp3XingFrameCount) {
  // dr_mp3 takes the length from the first frame's Xing frame count, which
  // the frames present do not bound.
  auto mp3 = mp3Frames(3, false);
  // MPEG-1 layer III stereo, no CRC: the tag follows 4 + 32 bytes.
  const size_t tag = 4 + 32;
  std::memcpy(mp3.data() + tag, "Xing", 4);
  mp3[tag + 7] = 0x01; // frame count present
  mp3[tag + 8] = 0x00;
  mp3[tag + 9] = 0x10; // 0x00100000 frames
  mp3[tag + 10] = 0x00;
  mp3[tag + 11] = 0x00;
  const auto seconds = lengthOf(mp3);
  ASSERT_TRUE(seconds.has_value());
  EXPECT_NEAR(*seconds, 0x00100000 * 1152.0 / 44100, 1e-6);
}

TEST(AudioLengthLimitTest, ReadsFlacBehindId3Tags) {
  // dr_flac skips leading ID3 tags (any number) before "fLaC".
  std::vector<uint8_t> buf;
  for (int i = 0; i < 2; ++i) {
    const std::vector<uint8_t> id3 = {'I', 'D', '3', 4, 0, 0, 0, 0, 0, 4};
    buf.insert(buf.end(), id3.begin(), id3.end());
    buf.insert(buf.end(), 4, 0);
  }
  const auto flac = flacHeader(48000, 48000ULL * 3600);
  buf.insert(buf.end(), flac.begin(), flac.end());
  const auto seconds = lengthOf(buf);
  ASSERT_TRUE(seconds.has_value());
  EXPECT_DOUBLE_EQ(*seconds, 3600.0);
}

TEST(AudioLengthLimitTest, RejectsOggBehindId3Tags) {
  // dr_flac would read Ogg FLAC here, whose length this code does not read.
  std::vector<uint8_t> buf = {'I', 'D', '3', 4, 0, 0, 0, 0, 0, 0};
  const std::vector<uint8_t> ogg = {'O', 'g', 'g', 'S', 0, 2, 0, 0, 0, 0, 0, 0};
  buf.insert(buf.end(), ogg.begin(), ogg.end());
  EXPECT_FALSE(lengthOf(buf).has_value());
}

namespace {
// A fmt chunk body: the 16 PCM fields, then cbSize and an extension when
// given.
std::vector<uint8_t> fmtBody(
    uint16_t format, uint16_t channels, uint32_t sampleRate,
    uint16_t blockAlign, uint16_t bitsPerSample,
    std::optional<std::vector<uint8_t>> extension = std::nullopt) {
  std::vector<uint8_t> b(16, 0);
  putLe(b, 0, format, 2);
  putLe(b, 2, channels, 2);
  putLe(b, 4, sampleRate, 4);
  putLe(b, 8, sampleRate * blockAlign, 4);
  putLe(b, 12, blockAlign, 2);
  putLe(b, 14, bitsPerSample, 2);
  if (extension.has_value()) {
    b.resize(18 + extension->size(), 0);
    putLe(b, 16, static_cast<uint32_t>(extension->size()), 2);
    std::copy(extension->begin(), extension->end(), b.begin() + 18);
  }
  return b;
}

// A RIFF WAVE holding @p chunks in order, each with its true size.
std::vector<uint8_t> riffWave(
    const std::vector<std::pair<std::string, std::vector<uint8_t>>>& chunks) {
  std::vector<uint8_t> buf(12, 0);
  std::memcpy(buf.data(), "RIFF", 4);
  std::memcpy(buf.data() + 8, "WAVE", 4);
  for (const auto& [id, body] : chunks) {
    const size_t at = buf.size();
    buf.resize(at + 8 + body.size() + (body.size() & 1), 0);
    std::memcpy(buf.data() + at, id.data(), 4);
    putLe(buf, at + 4, static_cast<uint32_t>(body.size()), 4);
    std::copy(body.begin(), body.end(), buf.begin() + at + 8);
  }
  putLe(buf, 4, static_cast<uint32_t>(buf.size() - 8), 4);
  return buf;
}
} // namespace

TEST(AudioLengthLimitTest, UsesTheLastFmtBeforeData) {
  // dr_wav keeps the last fmt chunk: 16-bit at 384 kHz, then 8-bit at 1 Hz,
  // so 1000 bytes decode to 1000 s, not ~1.3 ms.
  const auto wav = riffWave(
      {{"fmt ", fmtBody(1, 1, 384000, 2, 16)},
       {"fmt ", fmtBody(1, 1, 1, 1, 8)},
       {"data", std::vector<uint8_t>(1000, 0)}});
  const auto seconds = lengthOf(wav);
  ASSERT_TRUE(seconds.has_value());
  EXPECT_DOUBLE_EQ(*seconds, 1000.0);
  EXPECT_THROW(
      audio_length_limit::checkBuffer(wav.data(), wav.size(), 600),
      qvac_errors::StatusError);
}

TEST(AudioLengthLimitTest, RejectsFmtAfterData) {
  // dr_wav stops at the first data chunk, finds no fmt and fails, and
  // ma_decoder would read the bytes as MP3.
  const auto wav = riffWave(
      {{"data", std::vector<uint8_t>(64, 0)},
       {"fmt ", fmtBody(1, 1, 16000, 2, 16)}});
  EXPECT_FALSE(lengthOf(wav).has_value());
}

TEST(AudioLengthLimitTest, ReadsExtensibleFmtAsDrWavDoes) {
  // WAVE_FORMAT_EXTENSIBLE needs dr_wav's 22-byte extension; the format is
  // the sub-format GUID's first two bytes (here PCM).
  std::vector<uint8_t> extension(22, 0);
  putLe(extension, 6, 1, 2); // sub-format: PCM
  const auto good = riffWave(
      {{"fmt ", fmtBody(0xFFFE, 1, 16000, 2, 16, extension)},
       {"data", std::vector<uint8_t>(32000, 0)}});
  const auto seconds = lengthOf(good);
  ASSERT_TRUE(seconds.has_value());
  EXPECT_DOUBLE_EQ(*seconds, 1.0);

  const auto shortExtension = riffWave(
      {{"fmt ", fmtBody(0xFFFE, 1, 16000, 2, 16, std::vector<uint8_t>(10, 0))},
       {"data", std::vector<uint8_t>(32000, 0)}});
  EXPECT_FALSE(lengthOf(shortExtension).has_value());
}

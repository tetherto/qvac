#include "AudioLengthLimit.hpp"

#include <array>
#include <cstring>
#include <limits>
#include <string>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>

#include "addon/BertErrors.hpp"
#include "logging.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;

namespace audio_length_limit {
namespace {

uint32_t le16(const uint8_t* p) { return p[0] | (p[1] << 8); }
uint32_t le32(const uint8_t* p) {
  return p[0] | (p[1] << 8) | (p[2] << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

/// WAV: frames = data chunk size / bytes per frame, both as the header
/// declares them (miniaudio sizes its decode by the declared data size, not
/// by the bytes present). ADPCM blocks carry samplesPerBlock frames each.
std::optional<double> wavSeconds(const uint8_t* data, size_t size) {
  constexpr uint32_t kFormatMsAdpcm = 0x0002;
  constexpr uint32_t kFormatImaAdpcm = 0x0011;
  std::optional<uint32_t> sampleRate;
  uint32_t blockAlign = 0;
  uint32_t framesPerBlock = 1;
  // 64-bit, so a declared chunk size cannot wrap the offset.
  uint64_t off = 12;
  while (off + 8 <= size) {
    const uint8_t* chunk = data + off;
    const uint64_t chunkSize = le32(chunk + 4);
    const uint64_t body = off + 8;
    if (std::memcmp(chunk, "fmt ", 4) == 0) {
      if (body + 16 > size) {
        return std::nullopt;
      }
      const uint32_t format = le16(data + body);
      sampleRate = le32(data + body + 4);
      blockAlign = le16(data + body + 12);
      if ((format == kFormatMsAdpcm || format == kFormatImaAdpcm) &&
          chunkSize >= 20 && body + 20 <= size) {
        framesPerBlock = le16(data + body + 18);
      }
    } else if (std::memcmp(chunk, "data", 4) == 0) {
      if (!sampleRate.has_value() || *sampleRate == 0 || blockAlign == 0 ||
          framesPerBlock == 0) {
        return std::nullopt;
      }
      // A streaming writer leaves the size unset: miniaudio then reads to
      // the end of the buffer.
      const uint64_t declared = (chunkSize == 0 || chunkSize == 0xFFFFFFFFULL)
                                    ? size - body
                                    : chunkSize;
      const uint64_t frames = (declared / blockAlign) * framesPerBlock;
      return static_cast<double>(frames) / *sampleRate;
    }
    off = body + chunkSize + (chunkSize & 1);
  }
  return std::nullopt;
}

/// FLAC: STREAMINFO's sample rate and total samples. A stream that leaves
/// the total unset has no length to check, so it is not accepted.
std::optional<double> flacSeconds(const uint8_t* data, size_t size) {
  constexpr size_t kStreamInfo = 8; // "fLaC" + block header
  if (size < kStreamInfo + 18 || (data[4] & 0x7F) != 0) {
    return std::nullopt;
  }
  const uint8_t* info = data + kStreamInfo;
  const uint32_t sampleRate =
      (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  const uint64_t totalSamples = (static_cast<uint64_t>(info[13] & 0x0F) << 32) |
                                (static_cast<uint64_t>(info[14]) << 24) |
                                (info[15] << 16) | (info[16] << 8) | info[17];
  if (sampleRate == 0 || totalSamples == 0) {
    return std::nullopt;
  }
  return static_cast<double>(totalSamples) / sampleRate;
}

/// MP3: the sum over its MPEG audio frames, walked by their headers as
/// miniaudio counts them. Bytes between frames are skipped to the next sync.
std::optional<double> mp3Seconds(const uint8_t* data, size_t size) {
  // kbps, indexed [MPEG1 ? 0 : 1][layer 1..3 - 1][bitrate index].
  static constexpr std::array<std::array<std::array<uint16_t, 15>, 3>, 2>
      kBitrates = {{
          {{{0,
             32,
             64,
             96,
             128,
             160,
             192,
             224,
             256,
             288,
             320,
             352,
             384,
             416,
             448},
            {0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384},
            {0,
             32,
             40,
             48,
             56,
             64,
             80,
             96,
             112,
             128,
             160,
             192,
             224,
             256,
             320}}},
          {{{0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256},
            {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160},
            {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}}},
      }};
  // Hz, indexed [version bits][sample rate index]; version 1 is reserved.
  static constexpr std::array<std::array<uint32_t, 3>, 4> kSampleRates = {{
      {11025, 12000, 8000},  // MPEG 2.5
      {0, 0, 0},             // reserved
      {22050, 24000, 16000}, // MPEG 2
      {44100, 48000, 32000}, // MPEG 1
  }};

  size_t off = 0;
  // ID3v2 tag: 10-byte header, a syncsafe size and an optional footer.
  if (size >= 10 && std::memcmp(data, "ID3", 3) == 0) {
    const size_t tag = (static_cast<size_t>(data[6] & 0x7F) << 21) |
                       ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) |
                       (data[9] & 0x7F);
    off = 10 + tag + ((data[5] & 0x10) != 0 ? 10 : 0);
  }

  double seconds = 0;
  bool anyFrame = false;
  while (off + 4 <= size) {
    const uint8_t* h = data + off;
    const uint32_t version = (h[1] >> 3) & 3;
    const uint32_t layerBits = (h[1] >> 1) & 3;
    const uint32_t bitrateIndex = h[2] >> 4;
    const uint32_t rateIndex = (h[2] >> 2) & 3;
    const bool sync = h[0] == 0xFF && (h[1] & 0xE0) == 0xE0;
    if (!sync || version == 1 || layerBits == 0 || bitrateIndex == 15 ||
        rateIndex == 3) {
      ++off;
      continue;
    }
    if (bitrateIndex == 0) {
      // A free-format frame has no length in its header, but minimp3 decodes
      // it (it finds the next frame), so its samples cannot be counted here.
      return std::nullopt;
    }
    const uint32_t layer = 4 - layerBits; // 1, 2 or 3
    const bool mpeg1 = version == 3;
    const uint32_t bitrate =
        kBitrates[mpeg1 ? 0 : 1][layer - 1][bitrateIndex] * 1000U;
    const uint32_t sampleRate = kSampleRates[version][rateIndex];
    const uint32_t padding = (h[2] >> 1) & 1;
    const uint32_t samples =
        layer == 1 ? 384 : (layer == 2 || mpeg1 ? 1152 : 576);
    const size_t frameBytes =
        layer == 1 ? (12 * bitrate / sampleRate + padding) * 4
                   : samples / 8 * bitrate / sampleRate + padding;
    if (frameBytes < 4) {
      ++off;
      continue;
    }
    seconds += static_cast<double>(samples) / sampleRate;
    anyFrame = true;
    off += frameBytes;
  }
  if (!anyFrame) {
    return std::nullopt;
  }
  return seconds;
}

[[noreturn]] void throwUnsupportedMedia(const std::string& message) {
  qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback(
      GGML_LOG_LEVEL_WARN, (message + "\n").c_str(), nullptr);
  throw qvac_errors::StatusError(ADDON_ID, toString(UnsupportedMedia), message);
}

} // namespace

std::optional<double> durationSeconds(const uint8_t* data, size_t size) {
  if (data == nullptr || size < 12) {
    return std::nullopt;
  }
  if (std::memcmp(data, "RIFF", 4) == 0 &&
      std::memcmp(data + 8, "WAVE", 4) == 0) {
    return wavSeconds(data, size);
  }
  if (std::memcmp(data, "fLaC", 4) == 0) {
    return flacSeconds(data, size);
  }
  return mp3Seconds(data, size);
}

void checkBuffer(const uint8_t* data, size_t size, uint64_t maxSeconds) {
  const std::optional<double> seconds = durationSeconds(data, size);
  if (!seconds.has_value()) {
    throwUnsupportedMedia(
        "[AudioLengthLimit] Unsupported or corrupt audio: cannot determine "
        "its length before decoding.");
  }
  if (*seconds <= static_cast<double>(maxSeconds)) {
    return;
  }
  throwUnsupportedMedia(string_format(
      "[AudioLengthLimit] Audio of %.0f s exceeds the %llu s limit. Increase "
      "audio-max-seconds to allow longer audio.",
      *seconds,
      static_cast<unsigned long long>(maxSeconds)));
}

} // namespace audio_length_limit

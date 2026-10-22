#include "AudioLengthLimit.hpp"

#include <algorithm>
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

// The lengths below are miniaudio's (v0.11.25, as vendored by fabric):
// mtmd-helper sizes its decode by ma_decoder_get_length_in_pcm_frames, and
// ma_decoder tries WAV, then FLAC, then MP3 on the same bytes. Where the
// length depends on details this code does not mirror exactly, it takes the
// larger count, so it only ever rejects more.

uint32_t le16(const uint8_t* p) { return p[0] | (p[1] << 8); }
uint32_t le32(const uint8_t* p) {
  return p[0] | (p[1] << 8) | (p[2] << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}
uint32_t be32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) | (p[1] << 16) | (p[2] << 8) |
         p[3];
}

/// The offset after the ID3v2 tags at @p off, skipped in a loop as dr_flac
/// does (10-byte header, syncsafe size, 10 more with a footer).
uint64_t skipId3Tags(const uint8_t* data, size_t size, uint64_t off) {
  while (off + 10 <= size && std::memcmp(data + off, "ID3", 3) == 0) {
    const uint8_t* h = data + off;
    const uint64_t tag = (static_cast<uint64_t>(h[6] & 0x7F) << 21) |
                         ((h[7] & 0x7F) << 14) | ((h[8] & 0x7F) << 7) |
                         (h[9] & 0x7F);
    off += 10 + tag + ((h[5] & 0x10) != 0 ? 10 : 0);
  }
  return off;
}

/// WAV (RIFF), as dr_wav reads it. dr_wav's rejections are rejected here
/// too: ma_decoder would otherwise go on to read the bytes as MP3.
std::optional<double> wavSeconds(const uint8_t* data, size_t size) {
  constexpr uint32_t kAdpcm = 0x0002;
  constexpr uint32_t kAlaw = 0x0006;
  constexpr uint32_t kMulaw = 0x0007;
  constexpr uint32_t kDviAdpcm = 0x0011;
  constexpr uint32_t kExtensible = 0xFFFE;
  constexpr uint32_t kMaxSampleRate = 384000;
  constexpr uint32_t kMaxChannels = 256;
  constexpr uint32_t kMaxBitsPerSample = 64;

  bool haveFmt = false;
  uint32_t format = 0;
  uint32_t channels = 0;
  uint32_t sampleRate = 0;
  uint32_t blockAlign = 0;
  uint32_t bitsPerSample = 0;
  std::optional<uint64_t> dataSize;
  uint64_t factFrames = 0;

  // dr_wav's walk, as ma_decoder opens it (from memory, without metadata):
  // each fmt chunk replaces the last, and the walk stops at the first data
  // chunk, so a fmt or fact chunk after it is never read. 64-bit, so a
  // declared chunk size cannot wrap the offset.
  uint64_t off = 12;
  while (off + 8 <= size) {
    const uint8_t* chunk = data + off;
    const uint64_t chunkSize = le32(chunk + 4);
    const uint64_t body = off + 8;
    if (std::memcmp(chunk, "fmt ", 4) == 0) {
      if (chunkSize < 16 || body + 16 > size) {
        return std::nullopt;
      }
      haveFmt = true;
      format = le16(data + body);
      channels = le16(data + body + 2);
      sampleRate = le32(data + body + 4);
      blockAlign = le16(data + body + 12);
      bitsPerSample = le16(data + body + 14);
      // dr_wav reads cbSize and seeks over the extension; its memory stream
      // fails a seek past the end.
      uint32_t cbSize = 0;
      if (chunkSize > 16) {
        if (body + 18 > size) {
          return std::nullopt;
        }
        cbSize = le16(data + body + 16);
        if (body + 18 + cbSize > size) {
          return std::nullopt;
        }
      }
      // WAVE_FORMAT_EXTENSIBLE: dr_wav requires the 22-byte extension, and
      // the format is the sub-format GUID's first two bytes.
      if (format == kExtensible) {
        if (cbSize != 22) {
          return std::nullopt;
        }
        format = le16(data + body + 24);
      }
    } else if (std::memcmp(chunk, "fact", 4) == 0 && body + 4 <= size) {
      factFrames = std::max<uint64_t>(factFrames, le32(data + body));
    } else if (std::memcmp(chunk, "data", 4) == 0) {
      // The memory decoder can tell the size, so dr_wav reads to the end of
      // the buffer when the declared size is unset or larger.
      const uint64_t present = body <= size ? size - body : 0;
      dataSize = (chunkSize == 0xFFFFFFFFULL || chunkSize > present)
                     ? present
                     : chunkSize;
      break;
    }
    off = body + chunkSize + (chunkSize & 1);
  }

  if (!haveFmt || !dataSize.has_value() || sampleRate == 0 ||
      sampleRate > kMaxSampleRate || channels == 0 || channels > kMaxChannels ||
      bitsPerSample == 0 || bitsPerSample > kMaxBitsPerSample ||
      blockAlign == 0) {
    return std::nullopt;
  }
  const bool adpcm = format == kAdpcm || format == kDviAdpcm;
  if (adpcm && channels > 2) {
    return std::nullopt;
  }
  // dr_wav's bytes per frame: from the bit depth when it is whole bytes, the
  // block alignment otherwise; a-law and mu-law must be one byte a channel.
  uint64_t bytesPerFrame = (bitsPerSample & 7) == 0
                               ? uint64_t{bitsPerSample} * channels / 8
                               : blockAlign;
  if ((format == kAlaw || format == kMulaw) && bytesPerFrame != channels) {
    bytesPerFrame = 0;
  }
  if (bytesPerFrame == 0) {
    return std::nullopt;
  }

  uint64_t frames = 0;
  const uint64_t bytes = *dataSize;
  if (!adpcm) {
    frames = bytes / bytesPerFrame;
  } else {
    // dr_wav's block formula, in its unsigned 64-bit arithmetic (a short
    // data chunk wraps to a huge count, which is rejected below).
    uint64_t blocks = bytes / blockAlign;
    if (blocks * blockAlign < bytes) {
      ++blocks;
    }
    const uint64_t headerBytes =
        blocks * (format == kAdpcm ? 6 : 4) * uint64_t{channels};
    frames = ((bytes - headerBytes) * 2) / channels;
    if (format == kDviAdpcm) {
      frames += blocks;
    }
  }
  // dr_wav takes an MS ADPCM fact chunk's count over the formula.
  if (format == kAdpcm) {
    frames = std::max(frames, factFrames);
  }
  return static_cast<double>(frames) / sampleRate;
}

/// FLAC at @p off ("fLaC"), as dr_flac reads it: STREAMINFO must come first,
/// and its total sample count is the length. A stream that leaves the count
/// unset has no length to check, so it is not accepted.
std::optional<double>
flacSeconds(const uint8_t* data, size_t size, uint64_t off) {
  if (off + 8 + 18 > size || (data[off + 4] & 0x7F) != 0) {
    return std::nullopt;
  }
  const uint8_t* info = data + off + 8;
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

/// MP3, as dr_mp3 counts it: the frames present, or a Xing/Info header's
/// frame count when it declares more (dr_mp3 takes the length from the first
/// frame's tag). Every frame's tag is considered, in case dr_mp3's first
/// frame is not the first one found here.
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

  uint64_t off = skipId3Tags(data, size, 0);
  double walked = 0;
  double declared = 0;
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
    const uint64_t frameBytes =
        layer == 1 ? (12 * bitrate / sampleRate + padding) * 4
                   : samples / 8 * bitrate / sampleRate + padding;
    if (frameBytes < 4) {
      ++off;
      continue;
    }

    // Xing/Info sits after the header, the CRC and the layer III side info,
    // where dr_mp3 reads it; flag bit 0 means a frame count follows.
    const bool mono = (h[3] >> 6) == 3;
    const uint64_t sideInfo = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const uint64_t tag = off + 4 + ((h[1] & 1) == 0 ? 2 : 0) + sideInfo;
    if (tag + 12 <= size && (std::memcmp(data + tag, "Xing", 4) == 0 ||
                             std::memcmp(data + tag, "Info", 4) == 0)) {
      if ((data[tag + 7] & 0x01) != 0) {
        const double tagSeconds =
            static_cast<double>(be32(data + tag + 8)) * samples / sampleRate;
        declared = std::max(declared, tagSeconds);
      }
    }

    walked += static_cast<double>(samples) / sampleRate;
    anyFrame = true;
    off += frameBytes;
  }
  if (!anyFrame) {
    return std::nullopt;
  }
  return std::max(walked, declared);
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
  // ma_decoder's order: WAV, then FLAC (after any ID3 tags, native or Ogg),
  // then MP3.
  if (std::memcmp(data, "RIFF", 4) == 0 &&
      std::memcmp(data + 8, "WAVE", 4) == 0) {
    return wavSeconds(data, size);
  }
  const uint64_t afterTags = skipId3Tags(data, size, 0);
  if (afterTags + 4 <= size) {
    if (std::memcmp(data + afterTags, "fLaC", 4) == 0) {
      return flacSeconds(data, size, afterTags);
    }
    if (std::memcmp(data + afterTags, "OggS", 4) == 0) {
      // Ogg FLAC: its length is in Ogg pages this code does not read.
      return std::nullopt;
    }
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

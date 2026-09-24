#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace qvac::asrggml {

inline constexpr float PCM_S16_SCALE = 1.0F / 32768.0F;

inline float pcmS16ToFloat32(int16_t sample) {
  return static_cast<float>(sample) * PCM_S16_SCALE;
}

inline int16_t readLittleEndianS16(uint8_t lo, uint8_t hi) {
  return static_cast<int16_t>(lo | (hi << 8));
}

// Untrusted s16le PCM bytes (odd trailing byte is dropped). Allocation is
// bounded by the input size; this is the audio-buffer front door for Parakeet.
inline std::vector<float> decodeS16lePcm(const std::vector<uint8_t>& bytes) {
  const std::size_t nSamples = bytes.size() / 2;
  std::vector<float> out(nSamples);
  for (std::size_t i = 0; i < nSamples; ++i) {
    out[i] =
        pcmS16ToFloat32(readLittleEndianS16(bytes[i * 2], bytes[i * 2 + 1]));
  }
  return out;
}

} // namespace qvac::asrggml

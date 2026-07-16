#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace qvac::ttsggml {

// Full-scale magnitude for signed 16-bit PCM. Float samples in [-1, 1] map onto
// [-32767, 32767]; -32768 is left unused so the mapping stays symmetric. Shared
// by both engines so the float->int16 conversion can't drift between them.
inline constexpr float kInt16PcmScale = 32767.0f;

inline std::vector<int16_t> pcmFloatToInt16(const float* pcm, std::size_t samples) {
  std::vector<int16_t> out(samples);
  for (std::size_t i = 0; i < samples; ++i) {
    const float clamped = std::clamp(pcm[i], -1.0f, 1.0f);
    out[i] = static_cast<int16_t>(std::lround(clamped * kInt16PcmScale));
  }
  return out;
}

inline std::vector<int16_t> pcmFloatToInt16(const std::vector<float>& pcm) {
  return pcmFloatToInt16(pcm.data(), pcm.size());
}

} // namespace qvac::ttsggml

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace qvac::ttslib {

struct AudioResult {
  int sampleRate = 0;
  int channels = 1;
  std::vector<int16_t> pcm16;
  double durationMs = 0.0;
  uint64_t samples = 0;
};

} // namespace qvac::ttslib

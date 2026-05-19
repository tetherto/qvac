#pragma once

#include "src/model-interface/dsp/DspConstants.hpp"

#include <cmath>
#include <vector>

namespace qvac::ttslib::test {

inline std::vector<float> generateSine(float freq, int sampleRate,
                                       int numSamples, float amplitude = 1.0f) {
  std::vector<float> signal(numSamples);
  for (int i = 0; i < numSamples; i++) {
    signal[i] = amplitude * std::sin(2.0f * static_cast<float>(dsp::PI) * freq *
                                     i / sampleRate);
  }
  return signal;
}

inline float rms(const std::vector<float> &x) {
  float sum = 0.0f;
  for (float v : x) {
    sum += v * v;
  }
  return std::sqrt(sum / x.size());
}

inline float maxAbsDiff(const std::vector<float> &a,
                        const std::vector<float> &b) {
  float maxDiff = 0.0f;
  size_t len = std::min(a.size(), b.size());
  for (size_t i = 0; i < len; i++) {
    maxDiff = std::max(maxDiff, std::abs(a[i] - b[i]));
  }
  return maxDiff;
}

} // namespace qvac::ttslib::test

#pragma once

#include <vector>

namespace qvac::ttslib::dsp {

class FastLRMerge {
public:
  static std::vector<float> merge(const std::vector<float> &enhanced,
                                  const std::vector<float> &original,
                                  int sampleRate = 48000, int cutoffHz = 4000,
                                  int transitionBins = 256);
};

} // namespace qvac::ttslib::dsp

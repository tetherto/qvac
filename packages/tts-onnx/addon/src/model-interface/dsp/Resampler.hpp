#pragma once

#include <vector>

namespace qvac::ttslib::dsp {

class Resampler {
public:
  static std::vector<float> resample(const std::vector<float> &input, int srIn,
                                     int srOut);
};

} // namespace qvac::ttslib::dsp

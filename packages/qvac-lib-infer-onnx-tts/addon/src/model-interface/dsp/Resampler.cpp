#include "Resampler.hpp"

#include "DspConstants.hpp"

#include <algorithm>
#include <cmath>

namespace qvac::ttslib::dsp {

namespace {

const int LANCZOS_A = 5;

} // namespace

std::vector<float> Resampler::resample(const std::vector<float> &input,
                                       int srIn, int srOut) {
  if (srIn == srOut || input.empty()) {
    return input;
  }

  const double ratio = static_cast<double>(srOut) / srIn;
  const auto outLen = static_cast<size_t>(std::round(input.size() * ratio));
  std::vector<float> output(outLen, 0.0f);
  const double scale = std::min(1.0, ratio);

  for (size_t i = 0; i < outLen; i++) {
    const double center = i / ratio;
    const auto left =
        static_cast<int>(std::max(0.0, std::floor(center - LANCZOS_A / scale)));
    const auto right =
        static_cast<int>(std::min(static_cast<double>(input.size()) - 1,
                                  std::floor(center + LANCZOS_A / scale)));

    float sum = 0.0f;
    float weightSum = 0.0f;

    for (int j = left; j <= right; j++) {
      const double x = (center - j) * scale;
      double weight = 1.0;
      if (x != 0.0) {
        const double piX = PI * x;
        weight =
            std::sin(piX) * std::sin(piX / LANCZOS_A) / (piX * piX / LANCZOS_A);
      }
      sum += input[j] * static_cast<float>(weight);
      weightSum += static_cast<float>(weight);
    }

    output[i] = (weightSum > 0.0f) ? sum / weightSum : 0.0f;
  }

  return output;
}

} // namespace qvac::ttslib::dsp

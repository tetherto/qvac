#pragma once

// Output-sample-rate resampler for the addon's enhancer path.
//
// The non-enhancer path forwards `outputSampleRate` straight to the tts-cpp
// engine (EngineOptions::output_sample_rate), which resamples with its in-tree
// Kaiser sinc and keeps streaming seams correct. But the LavaSR enhancer runs
// in the addon and always emits 48 kHz, so when it is active the requested
// output rate must be applied here, after enhancement. This one-shot resample
// of a finite buffer is used both on the batch path (whole utterance) and
// inside StreamingEnhancer (per look-ahead window, before its crossfade), so
// it carries no cross-call state.
//
// Windowed-sinc (Lanczos, a=5) — identical math to tts-cpp's lavasr DSP
// resampler, so the two paths stay consistent.

#include <algorithm>
#include <cmath>
#include <vector>

namespace qvac::ttsggml {

struct OutputResampler {
  static std::vector<float>
  resample(const std::vector<float>& input, int sr_in, int sr_out) {
    if (sr_in == sr_out || input.empty()) {
      return input;
    }
    constexpr int kLanczosA = 5;
    constexpr double kPi = 3.14159265358979323846;

    const double ratio = static_cast<double>(sr_out) / sr_in;
    const auto out_len = static_cast<size_t>(std::round(input.size() * ratio));
    std::vector<float> output(out_len, 0.0f);
    const double scale = std::min(1.0, ratio);

    for (size_t i = 0; i < out_len; i++) {
      const double center = i / ratio;
      const int left = static_cast<int>(
          std::max(0.0, std::floor(center - kLanczosA / scale)));
      const int right = static_cast<int>(std::min(
          static_cast<double>(input.size()) - 1,
          std::floor(center + kLanczosA / scale)));

      float sum = 0.0f;
      float weight_sum = 0.0f;
      for (int j = left; j <= right; j++) {
        const double x = (center - j) * scale;
        double weight = 1.0;
        if (x != 0.0) {
          const double pi_x = kPi * x;
          weight = std::sin(pi_x) * std::sin(pi_x / kLanczosA) /
                   (pi_x * pi_x / kLanczosA);
        }
        sum += input[j] * static_cast<float>(weight);
        weight_sum += static_cast<float>(weight);
      }
      output[i] = (weight_sum > 0.0f) ? sum / weight_sum : 0.0f;
    }
    return output;
  }
};

} // namespace qvac::ttsggml

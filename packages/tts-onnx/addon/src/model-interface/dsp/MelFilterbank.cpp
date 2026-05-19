#include "MelFilterbank.hpp"

#include <algorithm>
#include <cmath>

namespace qvac::ttslib::dsp {

float MelFilterbank::hzToMelSlaney(float f) {
  if (f >= 1000.0f) {
    return 15.0f + std::log(f / 1000.0f) / (std::log(6.4f) / 27.0f);
  }
  return f / (200.0f / 3.0f);
}

float MelFilterbank::melToHzSlaney(float m) {
  if (m >= 15.0f) {
    return 1000.0f * std::exp((std::log(6.4f) / 27.0f) * (m - 15.0f));
  }
  return (200.0f / 3.0f) * m;
}

MelFilterbank::MelFilterbank(int sampleRate, int nFft, int nMels, float fMin,
                             float fMax)
    : sampleRate_(sampleRate), nFft_(nFft), nMels_(nMels), fMin_(fMin),
      fMax_(fMax) {
  const int nFreqs = nFft / 2 + 1;

  std::vector<float> fftfreqs(nFreqs);
  for (int i = 0; i < nFreqs; i++) {
    fftfreqs[i] = static_cast<float>(i) * sampleRate / nFft;
  }

  const float mMin = hzToMelSlaney(fMin);
  const float mMax = hzToMelSlaney(fMax);
  std::vector<float> fPts(nMels + 2);
  for (int i = 0; i < nMels + 2; i++) {
    fPts[i] = melToHzSlaney(mMin + i * (mMax - mMin) / (nMels + 1));
  }

  filters_.resize(nMels, std::vector<float>(nFreqs, 0.0f));
  for (int i = 0; i < nMels; i++) {
    const float fdiffLeft = std::max(fPts[i + 1] - fPts[i], 1e-12f);
    const float fdiffRight = std::max(fPts[i + 2] - fPts[i + 1], 1e-12f);
    const float enorm = 2.0f / std::max(fPts[i + 2] - fPts[i], 1e-12f);

    for (int j = 0; j < nFreqs; j++) {
      const float lower = (fftfreqs[j] - fPts[i]) / fdiffLeft;
      const float upper = (fPts[i + 2] - fftfreqs[j]) / fdiffRight;
      filters_[i][j] = std::max(0.0f, std::min(lower, upper)) * enorm;
    }
  }
}

std::vector<std::vector<float>>
MelFilterbank::melSpectrogram(const std::vector<float> &wav,
                              int hopLength) const {
  if (!cachedStft_ || cachedHopLength_ != hopLength) {
    cachedStft_ =
        std::make_unique<StftProcessor>(nFft_, hopLength, nFft_, false);
    cachedHopLength_ = hopLength;
  }
  const Spectrogram spec = cachedStft_->stft(wav);

  const int T = static_cast<int>(spec.size());
  const int nFreqs = nFft_ / 2 + 1;
  std::vector<std::vector<float>> mel(nMels_, std::vector<float>(T, 0.0f));

  for (int t = 0; t < T; t++) {
    for (int m = 0; m < nMels_; m++) {
      float sum = 0.0f;
      for (int f = 0; f < nFreqs; f++) {
        // Magnitude spectrogram (not power) — matches Vocos/LavaSR training
        sum += filters_[m][f] * std::abs(spec[t][f]);
      }
      mel[m][t] = std::log(std::max(sum, 1e-5f));
    }
  }

  return mel;
}

} // namespace qvac::ttslib::dsp

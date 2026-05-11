#pragma once

#include "StftProcessor.hpp"

#include <memory>
#include <vector>

namespace qvac::ttslib::dsp {

class MelFilterbank {
public:
  MelFilterbank(int sampleRate = 44100, int nFft = 2048, int nMels = 80,
                float fMin = 0.0f, float fMax = 8000.0f);

  // Returns [nMels][T] log-mel spectrogram from raw audio
  std::vector<std::vector<float>> melSpectrogram(const std::vector<float> &wav,
                                                 int hopLength) const;

  int nMels() const { return nMels_; }
  int nFft() const { return nFft_; }

private:
  static float hzToMelSlaney(float f);
  static float melToHzSlaney(float m);

  int sampleRate_;
  int nFft_;
  int nMels_;
  float fMin_;
  float fMax_;
  // [nMels][nFreqs] filter matrix, precomputed at construction
  std::vector<std::vector<float>> filters_;

  mutable std::unique_ptr<StftProcessor> cachedStft_;
  mutable int cachedHopLength_ = 0;
};

} // namespace qvac::ttslib::dsp

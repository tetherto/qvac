#pragma once

#include <complex>
#include <vector>

namespace qvac::ttslib::dsp {

using ComplexVec = std::vector<std::complex<float>>;
using Spectrogram = std::vector<std::vector<std::complex<float>>>;

class StftProcessor {
public:
  StftProcessor(int nFft, int hopLength, int winLength, bool centerPad);

  Spectrogram stft(const std::vector<float> &signal) const;
  std::vector<float> istft(const Spectrogram &spec, int targetLen = 0) const;

  static void fft(ComplexVec &x, bool inverse);

  int nFft() const { return nFft_; }
  int hopLength() const { return hopLength_; }
  int winLength() const { return winLength_; }

private:
  static std::vector<float> hannPeriodic(int length);
  static std::vector<float> padReflect(const std::vector<float> &x, int padLeft,
                                       int padRight);

  int nFft_;
  int hopLength_;
  int winLength_;
  bool centerPad_;
  std::vector<float> window_;
};

} // namespace qvac::ttslib::dsp

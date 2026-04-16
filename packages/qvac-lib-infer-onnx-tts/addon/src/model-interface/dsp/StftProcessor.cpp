#include "StftProcessor.hpp"

#include "DspConstants.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace qvac::ttslib::dsp {

StftProcessor::StftProcessor(int nFft, int hopLength, int winLength,
                             bool centerPad)
    : nFft_(nFft), hopLength_(hopLength), winLength_(winLength),
      centerPad_(centerPad), window_(hannPeriodic(winLength)) {}

void StftProcessor::fft(ComplexVec &x, bool inverse) {
  const int N = static_cast<int>(x.size());
  if (N <= 1) {
    return;
  }

  for (int i = 1, j = 0; i < N; i++) {
    int bit = N >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      std::swap(x[i], x[j]);
    }
  }

  for (int len = 2; len <= N; len <<= 1) {
    const float angle =
        2.0f * static_cast<float>(PI) / len * (inverse ? 1.0f : -1.0f);
    const std::complex<float> wlen(std::cos(angle), std::sin(angle));
    for (int i = 0; i < N; i += len) {
      std::complex<float> w(1.0f, 0.0f);
      for (int j = 0; j < len / 2; j++) {
        std::complex<float> u = x[i + j];
        std::complex<float> v = x[i + j + len / 2] * w;
        x[i + j] = u + v;
        x[i + j + len / 2] = u - v;
        w *= wlen;
      }
    }
  }

  if (inverse) {
    for (int i = 0; i < N; i++) {
      x[i] /= static_cast<float>(N);
    }
  }
}

std::vector<float> StftProcessor::hannPeriodic(int length) {
  std::vector<float> w(length);
  for (int i = 0; i < length; i++) {
    w[i] = 0.5f * (1.0f - std::cos(2.0f * static_cast<float>(PI) * i / length));
  }
  return w;
}

std::vector<float> StftProcessor::padReflect(const std::vector<float> &x,
                                             int padLeft, int padRight) {
  const int N = static_cast<int>(x.size());
  if (N <= 1) {
    return std::vector<float>(N + padLeft + padRight, N == 1 ? x[0] : 0.0f);
  }
  std::vector<float> y(N + padLeft + padRight);
  for (int i = -padLeft; i < N + padRight; i++) {
    int idx = i;
    while (idx < 0 || idx >= N) {
      if (idx < 0) {
        idx = -idx;
      }
      if (idx >= N) {
        idx = 2 * N - 2 - idx;
      }
    }
    y[i + padLeft] = x[idx];
  }
  return y;
}

Spectrogram StftProcessor::stft(const std::vector<float> &signal) const {
  const int pad = centerPad_ ? (nFft_ / 2) : ((winLength_ - hopLength_) / 2);
  std::vector<float> xpad = padReflect(signal, pad, pad);
  if (static_cast<int>(xpad.size()) < winLength_) {
    xpad.resize(winLength_, 0.0f);
  }

  const int numFrames =
      (static_cast<int>(xpad.size()) - winLength_) / hopLength_ + 1;
  const int freqBins = nFft_ / 2 + 1;

  Spectrogram spec(numFrames, std::vector<std::complex<float>>(freqBins));
  ComplexVec frame(nFft_);

  for (int t = 0; t < numFrames; t++) {
    std::fill(frame.begin(), frame.end(), std::complex<float>{0.0f, 0.0f});
    for (int i = 0; i < winLength_; i++) {
      frame[i] = {xpad[t * hopLength_ + i] * window_[i], 0.0f};
    }
    fft(frame, false);
    for (int f = 0; f < freqBins; f++) {
      spec[t][f] = frame[f];
    }
  }

  return spec;
}

std::vector<float> StftProcessor::istft(const Spectrogram &spec,
                                        int targetLen) const {
  const int pad = centerPad_ ? (nFft_ / 2) : ((winLength_ - hopLength_) / 2);
  const int T = static_cast<int>(spec.size());
  const int outputSize = (T - 1) * hopLength_ + winLength_;

  std::vector<float> y(outputSize, 0.0f);
  std::vector<float> wenv(outputSize, 0.0f);
  ComplexVec frame(nFft_);

  for (int t = 0; t < T; t++) {
    std::fill(frame.begin(), frame.end(), std::complex<float>{0.0f, 0.0f});
    for (int f = 0; f <= nFft_ / 2; f++) {
      frame[f] = spec[t][f];
      if (f > 0 && f < nFft_ / 2) {
        frame[nFft_ - f] = std::conj(spec[t][f]);
      }
    }
    fft(frame, true);

    for (int i = 0; i < winLength_; i++) {
      y[t * hopLength_ + i] += frame[i].real() * window_[i];
      wenv[t * hopLength_ + i] += window_[i] * window_[i];
    }
  }

  std::vector<float> out;
  out.reserve(outputSize - 2 * pad);
  for (int i = pad; i < outputSize - pad; i++) {
    out.push_back(y[i] / std::max(wenv[i], 1e-8f));
  }

  if (targetLen > 0) {
    out.resize(targetLen, 0.0f);
  }

  return out;
}

} // namespace qvac::ttslib::dsp

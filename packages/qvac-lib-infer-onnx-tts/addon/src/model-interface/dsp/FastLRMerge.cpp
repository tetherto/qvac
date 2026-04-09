#include "FastLRMerge.hpp"

#include "StftProcessor.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace qvac::ttslib::dsp {

std::vector<float> FastLRMerge::merge(const std::vector<float> &enhanced,
                                      const std::vector<float> &original,
                                      int sampleRate, int cutoffHz,
                                      int transitionBins) {
  const int N = static_cast<int>(enhanced.size());
  const int M = static_cast<int>(original.size());
  if (N == 0) {
    return {};
  }
  if (M == 0) {
    return enhanced;
  }
  if (N != M) {
    throw std::invalid_argument("FastLRMerge: enhanced (" + std::to_string(N) +
                                ") and original (" + std::to_string(M) +
                                ") must have equal length");
  }

  int nPow2 = 1;
  while (nPow2 < std::max(N, M)) {
    nPow2 <<= 1;
  }

  ComplexVec spec1(nPow2, {0.0f, 0.0f});
  ComplexVec spec2(nPow2, {0.0f, 0.0f});
  for (int i = 0; i < N; i++) {
    spec1[i] = {enhanced[i], 0.0f};
  }
  for (int i = 0; i < M; i++) {
    spec2[i] = {original[i], 0.0f};
  }

  StftProcessor::fft(spec1, false);
  StftProcessor::fft(spec2, false);

  const int nBins = nPow2 / 2 + 1;
  const int cutoffBin =
      static_cast<int>(cutoffHz / (sampleRate / 2.0f) * nBins);
  const int half = transitionBins / 2;
  const int start = std::max(0, cutoffBin - half);
  const int end = std::min(nBins, cutoffBin + half);

  // Build crossover mask: 0 below cutoff (use original), 1 above (use enhanced)
  // Cubic Hermite interpolation in the transition band
  std::vector<float> mask(nBins, 1.0f);
  for (int i = 0; i < start; i++) {
    mask[i] = 0.0f;
  }
  if (end - start > 1) {
    for (int i = start; i < end; i++) {
      const float x =
          -1.0f + 2.0f * (i - start) / static_cast<float>(end - start - 1);
      const float t = (x + 1.0f) / 2.0f;
      mask[i] = 3.0f * t * t - 2.0f * t * t * t;
    }
  } else if (end == start + 1) {
    mask[start] = 0.5f;
  }

  // Blend spectra: original low-freq + enhanced high-freq
  for (int i = 0; i < nBins; i++) {
    spec2[i] = spec2[i] + (spec1[i] - spec2[i]) * mask[i];
    if (i > 0 && i < nPow2 / 2) {
      spec2[nPow2 - i] = std::conj(spec2[i]);
    }
  }
  spec2[nPow2 / 2] = {spec2[nPow2 / 2].real(), 0.0f};

  StftProcessor::fft(spec2, true);

  std::vector<float> out(N);
  for (int i = 0; i < N; i++) {
    out[i] = spec2[i].real();
  }
  return out;
}

} // namespace qvac::ttslib::dsp

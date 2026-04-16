#include <gtest/gtest.h>

#include "DspTestHelpers.hpp"
#include "src/model-interface/dsp/StftProcessor.hpp"

using namespace qvac::ttslib::dsp;
using qvac::ttslib::test::generateSine;
using qvac::ttslib::test::maxAbsDiff;
using qvac::ttslib::test::rms;

TEST(StftProcessorTest, FFTRoundTrip) {
  const int N = 256;
  ComplexVec x(N);
  for (int i = 0; i < N; i++) {
    x[i] = {static_cast<float>(i), 0.0f};
  }

  ComplexVec original = x;
  StftProcessor::fft(x, false);
  StftProcessor::fft(x, true);

  for (int i = 0; i < N; i++) {
    EXPECT_NEAR(x[i].real(), original[i].real(), 1e-3f)
        << "Mismatch at index " << i;
    EXPECT_NEAR(x[i].imag(), original[i].imag(), 1e-3f)
        << "Mismatch at index " << i;
  }
}

TEST(StftProcessorTest, StftIstftRoundTripCenterPad) {
  auto signal = generateSine(440.0f, 16000, 16000);
  StftProcessor stft(512, 256, 512, true);

  auto spec = stft.stft(signal);
  auto reconstructed = stft.istft(spec, signal.size());

  ASSERT_EQ(reconstructed.size(), signal.size());
  // Skip boundary samples where windowed OLA may diverge
  int margin = 512;
  float diff = 0.0f;
  for (size_t i = margin; i < signal.size() - margin; i++) {
    diff = std::max(diff, std::abs(reconstructed[i] - signal[i]));
  }
  EXPECT_LT(diff, 0.01f)
      << "STFT->ISTFT round-trip error too large (center_pad=true)";
}

TEST(StftProcessorTest, StftIstftRoundTripSamePad) {
  auto signal = generateSine(440.0f, 48000, 48000);
  StftProcessor stft(2048, 512, 2048, false);

  auto spec = stft.stft(signal);
  auto reconstructed = stft.istft(spec, signal.size());

  ASSERT_EQ(reconstructed.size(), signal.size());
  int margin = 2048;
  float diff = 0.0f;
  for (size_t i = margin; i < signal.size() - margin; i++) {
    diff = std::max(diff, std::abs(reconstructed[i] - signal[i]));
  }
  EXPECT_LT(diff, 0.01f)
      << "STFT->ISTFT round-trip error too large (center_pad=false)";
}

TEST(StftProcessorTest, StftOutputShape) {
  const int numSamples = 16000;
  auto signal = generateSine(440.0f, 16000, numSamples);
  StftProcessor stft(512, 256, 512, true);

  auto spec = stft.stft(signal);
  int freqBins = 512 / 2 + 1;

  EXPECT_GT(spec.size(), 0u);
  for (const auto &frame : spec) {
    EXPECT_EQ(static_cast<int>(frame.size()), freqBins);
  }
}

TEST(StftProcessorTest, EnergyPreservation) {
  auto signal = generateSine(1000.0f, 16000, 8000);
  float inputRms = rms(signal);

  StftProcessor stft(512, 256, 512, true);
  auto spec = stft.stft(signal);
  auto reconstructed = stft.istft(spec, signal.size());
  float outputRms = rms(reconstructed);

  float ratio = outputRms / inputRms;
  EXPECT_GT(ratio, 0.95f);
  EXPECT_LT(ratio, 1.05f);
}

TEST(StftProcessorTest, ShortSignal) {
  std::vector<float> shortSignal(100, 0.5f);
  StftProcessor stft(512, 256, 512, true);

  auto spec = stft.stft(shortSignal);
  EXPECT_GT(spec.size(), 0u);

  auto reconstructed = stft.istft(spec, shortSignal.size());
  EXPECT_EQ(reconstructed.size(), shortSignal.size());
}

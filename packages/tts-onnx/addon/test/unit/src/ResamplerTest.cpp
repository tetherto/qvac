#include <gtest/gtest.h>

#include "DspTestHelpers.hpp"
#include "src/model-interface/dsp/Resampler.hpp"

using namespace qvac::ttslib::dsp;
using qvac::ttslib::test::generateSine;
using qvac::ttslib::test::rms;

TEST(ResamplerTest, Identity) {
  auto signal = generateSine(440.0f, 16000, 16000);
  auto result = Resampler::resample(signal, 16000, 16000);

  ASSERT_EQ(result.size(), signal.size());
  for (size_t i = 0; i < signal.size(); i++) {
    EXPECT_FLOAT_EQ(result[i], signal[i]);
  }
}

TEST(ResamplerTest, EmptyInput) {
  std::vector<float> empty;
  auto result = Resampler::resample(empty, 16000, 48000);
  EXPECT_TRUE(result.empty());
}

TEST(ResamplerTest, Downsample24kTo16k) {
  int srIn = 24000;
  int srOut = 16000;
  int numSamples = 24000;
  auto signal = generateSine(440.0f, srIn, numSamples);
  auto result = Resampler::resample(signal, srIn, srOut);

  int expectedLen =
      static_cast<int>(std::round(numSamples * (double)srOut / srIn));
  EXPECT_EQ(static_cast<int>(result.size()), expectedLen);
}

TEST(ResamplerTest, Upsample16kTo48k) {
  int srIn = 16000;
  int srOut = 48000;
  int numSamples = 16000;
  auto signal = generateSine(440.0f, srIn, numSamples);
  auto result = Resampler::resample(signal, srIn, srOut);

  int expectedLen =
      static_cast<int>(std::round(numSamples * (double)srOut / srIn));
  EXPECT_EQ(static_cast<int>(result.size()), expectedLen);
}

TEST(ResamplerTest, Downsample44100To16000) {
  int srIn = 44100;
  int srOut = 16000;
  int numSamples = 44100;
  auto signal = generateSine(440.0f, srIn, numSamples);
  auto result = Resampler::resample(signal, srIn, srOut);

  int expectedLen =
      static_cast<int>(std::round(numSamples * (double)srOut / srIn));
  EXPECT_EQ(static_cast<int>(result.size()), expectedLen);
}

TEST(ResamplerTest, Downsample48kTo22050) {
  int srIn = 48000;
  int srOut = 22050;
  int numSamples = 48000;
  auto signal = generateSine(440.0f, srIn, numSamples);
  auto result = Resampler::resample(signal, srIn, srOut);

  int expectedLen =
      static_cast<int>(std::round(numSamples * (double)srOut / srIn));
  EXPECT_EQ(static_cast<int>(result.size()), expectedLen);
}

TEST(ResamplerTest, EnergyPreservation) {
  auto signal = generateSine(440.0f, 24000, 24000);
  float inputRms = rms(signal);

  auto result = Resampler::resample(signal, 24000, 48000);
  float outputRms = rms(result);

  float ratio = outputRms / inputRms;
  EXPECT_GT(ratio, 0.85f) << "Resampled signal lost too much energy";
  EXPECT_LT(ratio, 1.15f) << "Resampled signal gained too much energy";
}

TEST(ResamplerTest, LowFreqPreservation) {
  auto signal = generateSine(100.0f, 24000, 24000);
  auto upsampled = Resampler::resample(signal, 24000, 48000);
  auto roundTrip = Resampler::resample(upsampled, 48000, 24000);

  ASSERT_EQ(roundTrip.size(), signal.size());
  float maxErr = 0.0f;
  for (size_t i = 100; i < signal.size() - 100; i++) {
    maxErr = std::max(maxErr, std::abs(roundTrip[i] - signal[i]));
  }
  EXPECT_LT(maxErr, 0.1f) << "Low-frequency round-trip error too large";
}

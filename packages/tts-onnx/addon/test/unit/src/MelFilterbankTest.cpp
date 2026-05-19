#include <gtest/gtest.h>

#include "DspTestHelpers.hpp"
#include "src/model-interface/dsp/MelFilterbank.hpp"

using namespace qvac::ttslib::dsp;
using qvac::ttslib::test::generateSine;

TEST(MelFilterbankTest, DefaultBinCount) {
  MelFilterbank mel;
  EXPECT_EQ(mel.nMels(), 80);
  EXPECT_EQ(mel.nFft(), 2048);
}

TEST(MelFilterbankTest, CustomBinCount) {
  MelFilterbank mel(16000, 512, 40, 0.0f, 8000.0f);
  EXPECT_EQ(mel.nMels(), 40);
  EXPECT_EQ(mel.nFft(), 512);
}

TEST(MelFilterbankTest, MelSpectrogramShape) {
  MelFilterbank mel(44100, 2048, 80, 0.0f, 8000.0f);
  auto signal = generateSine(440.0f, 44100, 44100);

  auto spec = mel.melSpectrogram(signal, 512);

  EXPECT_EQ(static_cast<int>(spec.size()), 80);
  EXPECT_GT(spec[0].size(), 0u);

  for (const auto &band : spec) {
    EXPECT_EQ(band.size(), spec[0].size());
  }
}

TEST(MelFilterbankTest, OutputIsFinite) {
  MelFilterbank mel(44100, 2048, 80, 0.0f, 8000.0f);
  auto signal = generateSine(440.0f, 44100, 44100);
  auto spec = mel.melSpectrogram(signal, 512);

  for (const auto &band : spec) {
    for (float val : band) {
      EXPECT_TRUE(std::isfinite(val)) << "Non-finite mel value detected";
    }
  }
}

TEST(MelFilterbankTest, SilenceProducesLowValues) {
  MelFilterbank mel(44100, 2048, 80, 0.0f, 8000.0f);
  std::vector<float> silence(44100, 0.0f);

  auto spec = mel.melSpectrogram(silence, 512);

  for (const auto &band : spec) {
    for (float val : band) {
      EXPECT_LT(val, 0.0f) << "Silence should produce negative log-mel values";
    }
  }
}

TEST(MelFilterbankTest, ToneProducesHigherEnergy) {
  MelFilterbank mel(44100, 2048, 80, 0.0f, 8000.0f);
  auto tone = generateSine(1000.0f, 44100, 44100);
  std::vector<float> silence(44100, 0.0f);

  auto toneMel = mel.melSpectrogram(tone, 512);
  auto silenceMel = mel.melSpectrogram(silence, 512);

  float toneSum = 0.0f, silenceSum = 0.0f;
  for (int m = 0; m < 80; m++) {
    for (size_t t = 0; t < toneMel[m].size(); t++) {
      toneSum += toneMel[m][t];
    }
    for (size_t t = 0; t < silenceMel[m].size(); t++) {
      silenceSum += silenceMel[m][t];
    }
  }

  EXPECT_GT(toneSum, silenceSum)
      << "A tone should produce higher total mel energy than silence";
}

TEST(MelFilterbankTest, MatchesVocosConfig) {
  // Vocos config from LavaSR: sample_rate=44100, n_fft=2048, n_mels=80,
  // fmin=0, fmax=8000 (even though processing 48kHz audio)
  MelFilterbank mel(44100, 2048, 80, 0.0f, 8000.0f);

  auto signal = generateSine(440.0f, 48000, 48000);
  auto spec = mel.melSpectrogram(signal, 512);

  EXPECT_EQ(static_cast<int>(spec.size()), 80);
  EXPECT_GT(spec[0].size(), 0u);
}

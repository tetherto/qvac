#include <gtest/gtest.h>

#include "DspTestHelpers.hpp"
#include "src/model-interface/dsp/FastLRMerge.hpp"

using namespace qvac::ttslib::dsp;
using qvac::ttslib::test::generateSine;
using qvac::ttslib::test::rms;

TEST(FastLRMergeTest, SameSignalPassthrough) {
  auto signal = generateSine(1000.0f, 48000, 48000);
  auto result = FastLRMerge::merge(signal, signal, 48000, 4000);

  ASSERT_EQ(result.size(), signal.size());
  float maxDiff = 0.0f;
  for (size_t i = 0; i < signal.size(); i++) {
    maxDiff = std::max(maxDiff, std::abs(result[i] - signal[i]));
  }
  EXPECT_LT(maxDiff, 0.01f)
      << "Merging identical signals should produce nearly identical output";
}

TEST(FastLRMergeTest, OutputLength) {
  auto enhanced = generateSine(440.0f, 48000, 48000);
  auto original = generateSine(440.0f, 48000, 48000);
  auto result = FastLRMerge::merge(enhanced, original, 48000, 4000);
  EXPECT_EQ(result.size(), enhanced.size());
}

TEST(FastLRMergeTest, LowFrequencyFromOriginal) {
  // Below cutoff, output should follow original
  auto enhanced = generateSine(100.0f, 48000, 48000);
  std::vector<float> original(48000, 0.0f);

  // 100 Hz is well below 4000 Hz cutoff -> output should be near zero (from
  // original)
  auto result = FastLRMerge::merge(enhanced, original, 48000, 4000);

  float enhancedRms = rms(enhanced);
  float resultRms = rms(result);

  EXPECT_LT(resultRms, enhancedRms * 0.3f)
      << "Low-frequency content should come from original (near-zero) signal";
}

TEST(FastLRMergeTest, HighFrequencyFromEnhanced) {
  // Above cutoff, output should follow enhanced
  std::vector<float> enhanced = generateSine(10000.0f, 48000, 48000);
  std::vector<float> original(48000, 0.0f);

  // 10 kHz is above 4000 Hz cutoff -> output should match enhanced
  auto result = FastLRMerge::merge(enhanced, original, 48000, 4000);

  float enhancedRms = rms(enhanced);
  float resultRms = rms(result);

  EXPECT_GT(resultRms, enhancedRms * 0.7f)
      << "High-frequency content should come from enhanced signal";
}

TEST(FastLRMergeTest, OutputIsFinite) {
  auto enhanced = generateSine(440.0f, 48000, 48000);
  auto original = generateSine(880.0f, 48000, 48000);
  auto result = FastLRMerge::merge(enhanced, original, 48000, 4000);

  for (float val : result) {
    EXPECT_TRUE(std::isfinite(val)) << "Non-finite value in merge output";
  }
}

TEST(FastLRMergeTest, SmallSignal) {
  auto enhanced = generateSine(440.0f, 48000, 512);
  auto original = generateSine(440.0f, 48000, 512);
  auto result = FastLRMerge::merge(enhanced, original, 48000, 4000);
  EXPECT_EQ(result.size(), enhanced.size());
}

TEST(FastLRMergeTest, CustomCutoff) {
  auto enhanced = generateSine(440.0f, 48000, 48000);
  auto original = generateSine(440.0f, 48000, 48000);

  auto result8k = FastLRMerge::merge(enhanced, original, 48000, 8000);
  auto result12k = FastLRMerge::merge(enhanced, original, 48000, 12000);

  EXPECT_EQ(result8k.size(), enhanced.size());
  EXPECT_EQ(result12k.size(), enhanced.size());
}

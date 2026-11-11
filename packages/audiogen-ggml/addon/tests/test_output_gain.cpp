#include <vector>

#include <gtest/gtest.h>

#include "model-interface/acestep/OutputGain.hpp"

using qvac::audiogenggml::acestep::outputGain;
using qvac::audiogenggml::acestep::OutputGainRequest;

namespace {
// Peaks at 1.25: outside [-1, 1], as the VAE's raw output routinely is.
const std::vector<float> LOUD_PCM{0.5F, -1.25F, 0.25F, 1.0F};
} // namespace

TEST(OutputGainTest, ScalesANormalizedGenerationToTheTargetPeak) {
  EXPECT_FLOAT_EQ(outputGain(LOUD_PCM, OutputGainRequest{}), 0.9F / 1.25F);
}

TEST(OutputGainTest, LeavesRawOutputAloneWhenNormalizationIsOff) {
  EXPECT_EQ(
      outputGain(LOUD_PCM, OutputGainRequest{.normalizeLoudness = false}),
      1.0F);
}

TEST(OutputGainTest, KeepsALegoStemAtItsMixGain) {
  EXPECT_EQ(outputGain(LOUD_PCM, OutputGainRequest{.isLegoStem = true}), 1.0F);
}

TEST(OutputGainTest, PreservesEditOutput) {
  EXPECT_EQ(outputGain(LOUD_PCM, OutputGainRequest{.isEdit = true}), 1.0F);
}

TEST(OutputGainTest, DoesNotAmplifySilence) {
  const std::vector<float> nearSilent{0.0F, 5e-4F, -5e-4F};
  EXPECT_EQ(outputGain(nearSilent, OutputGainRequest{}), 1.0F);
  EXPECT_EQ(outputGain({}, OutputGainRequest{}), 1.0F);
}

TEST(OutputGainTest, AttenuatesAQuietGenerationUpToTheTargetPeak) {
  const std::vector<float> quiet{0.1F, -0.3F};
  EXPECT_FLOAT_EQ(outputGain(quiet, OutputGainRequest{}), 0.9F / 0.3F);
}

// Unit tests for OutputResampler, the windowed-sinc (Lanczos a=5) resampler the
// addon applies on the LavaSR enhancer path (the enhancer always emits 48 kHz,
// so a caller-requested output rate is honored here). Exercised in isolation —
// no engine / GGUF — so these always run. Also guards the loop extraction
// (lanczosWeight / resampleOne) done for the coding-standards refactor.

#include <cmath>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/OutputResampler.hpp"

using qvac::ttsggml::OutputResampler;

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<float> sine(double freqHz, double seconds, int sr) {
  const auto n = static_cast<std::size_t>(seconds * sr);
  std::vector<float> out(n);
  const double w = 2.0 * kPi * freqHz / static_cast<double>(sr);
  for (std::size_t i = 0; i < n; ++i)
    out[i] = static_cast<float>(std::sin(w * static_cast<double>(i)));
  return out;
}

// Dominant period (in samples) via autocorrelation peak over a lag range.
int dominantPeriod(const std::vector<float>& x, int minLag, int maxLag) {
  int bestLag = minLag;
  double best = -1e30;
  for (int lag = minLag; lag <= maxLag; ++lag) {
    double acc = 0.0;
    for (std::size_t i = 0; i + static_cast<std::size_t>(lag) < x.size(); ++i)
      acc += static_cast<double>(x[i]) * static_cast<double>(x[i + lag]);
    if (acc > best) {
      best = acc;
      bestLag = lag;
    }
  }
  return bestLag;
}

} // namespace

TEST(OutputResampler, IdentityRateReturnsInputUnchanged) {
  const auto in = sine(300.0, 0.05, 24000);
  const auto out = OutputResampler::resample(in, 24000, 24000);
  ASSERT_EQ(out.size(), in.size());
  for (std::size_t i = 0; i < in.size(); ++i)
    EXPECT_FLOAT_EQ(out[i], in[i]);
}

TEST(OutputResampler, EmptyInputReturnsEmpty) {
  const std::vector<float> in;
  EXPECT_TRUE(OutputResampler::resample(in, 24000, 48000).empty());
}

TEST(OutputResampler, UpsampleDoublesLength) {
  const auto in = sine(300.0, 0.1, 24000);
  const auto out = OutputResampler::resample(in, 24000, 48000);
  EXPECT_EQ(out.size(), in.size() * 2);
}

TEST(OutputResampler, DownsampleHalvesLength) {
  const auto in = sine(300.0, 0.1, 48000);
  const auto out = OutputResampler::resample(in, 48000, 24000);
  EXPECT_EQ(out.size(), in.size() / 2);
}

TEST(OutputResampler, PreservesConstantSignal) {
  // Normalized Lanczos weights sum to 1, so a DC input must come back as the
  // same constant — exactly what the weight-sum division in resampleOne
  // guarantees. A direct check on the extracted kernel.
  const std::vector<float> in(4096, 0.5f);
  const auto up = OutputResampler::resample(in, 24000, 48000);
  ASSERT_FALSE(up.empty());
  for (std::size_t i = 64; i + 64 < up.size(); ++i)
    EXPECT_NEAR(up[i], 0.5f, 1e-4f);
}

TEST(OutputResampler, PreservesToneFrequencyOnUpsample) {
  // A 300 Hz tone has period 80 samples at 24 kHz and 160 at 48 kHz; correct
  // interpolation keeps the frequency (the period scales with the rate ratio).
  const auto in = sine(300.0, 0.2, 24000);
  const auto out = OutputResampler::resample(in, 24000, 48000);
  for (const float s : out)
    ASSERT_TRUE(std::isfinite(s));
  EXPECT_NEAR(dominantPeriod(out, 160 - 20, 160 + 20), 160, 4);
}

// Unit tests for the WSOLA pitch-preserving time-stretch used by
// ChatterboxModel to implement the `speed` knob (Chatterbox has no native
// rate control).  These exercise the DSP in isolation — no GGUF / engine —
// so they always run.

#include <cmath>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/chatterbox/TimeStretch.hpp"

using qvac::ttsggml::chatterbox::WsolaTimeStretch;

namespace {

constexpr int kSampleRate = 24000;

// A pure tone — useful because pitch (fundamental frequency) must survive a
// pitch-preserving stretch, whereas a naive resample would shift it.
std::vector<float> sine(float freqHz, float seconds, int sr = kSampleRate) {
  const auto n = static_cast<std::size_t>(seconds * sr);
  std::vector<float> out(n);
  const float w = 2.0f * 3.14159265358979f * freqHz / static_cast<float>(sr);
  for (std::size_t i = 0; i < n; ++i)
    out[i] = std::sin(w * static_cast<float>(i));
  return out;
}

// Dominant period (in samples) via autocorrelation peak over a plausible
// speech/tone lag range — a cheap pitch estimate.
int dominantPeriod(const std::vector<float>& x, int minLag, int maxLag) {
  int bestLag = minLag;
  double best = -1e30;
  for (int lag = minLag; lag <= maxLag; ++lag) {
    double acc = 0.0;
    for (std::size_t i = 0; i + lag < x.size(); ++i)
      acc += static_cast<double>(x[i]) * static_cast<double>(x[i + lag]);
    if (acc > best) {
      best = acc;
      bestLag = lag;
    }
  }
  return bestLag;
}

} // namespace

TEST(WsolaTimeStretch, IdentityPreservesLength) {
  const auto in = sine(200.0f, 1.0f);
  const auto out = WsolaTimeStretch::apply(in, 1.0f);
  // speed 1.0 -> Ha == Hs, output length ~= input length (within a frame).
  EXPECT_NEAR(
      static_cast<double>(out.size()), static_cast<double>(in.size()), 2048.0);
}

TEST(WsolaTimeStretch, SlowerLengthensOutput) {
  const auto in = sine(200.0f, 1.0f);
  const auto out = WsolaTimeStretch::apply(in, 0.5f); // half speed -> ~2x len
  const double ratio = static_cast<double>(out.size()) / in.size();
  EXPECT_NEAR(ratio, 2.0, 0.1);
}

TEST(WsolaTimeStretch, FasterShortensOutput) {
  const auto in = sine(200.0f, 1.0f);
  const auto out = WsolaTimeStretch::apply(in, 2.0f); // double speed -> ~0.5x
  const double ratio = static_cast<double>(out.size()) / in.size();
  EXPECT_NEAR(ratio, 0.5, 0.1);
}

TEST(WsolaTimeStretch, PreservesPitchWhenSlowing) {
  const float freq = 200.0f; // period = 120 samples @ 24 kHz
  const auto in = sine(freq, 1.0f);
  const auto out = WsolaTimeStretch::apply(in, 0.7f);

  const int expected = static_cast<int>(std::lround(kSampleRate / freq)); // 120
  const int got = dominantPeriod(out, expected - 40, expected + 40);
  // A pitch-preserving stretch keeps the period; a resample would scale it
  // by 1/speed (~171 samples here), well outside this window.
  EXPECT_NEAR(got, expected, 8);
}

TEST(WsolaTimeStretch, StreamingMatchesBatchLength) {
  const auto in = sine(180.0f, 1.3f);
  const float speed = 0.8f;

  const auto batch = WsolaTimeStretch::apply(in, speed);

  // Feed the same signal in ~0.1 s chunks through one stretcher instance.
  WsolaTimeStretch streamer(speed);
  std::vector<float> streamed;
  const std::size_t chunk = 2400;
  for (std::size_t off = 0; off < in.size(); off += chunk) {
    const std::size_t n = std::min(chunk, in.size() - off);
    const auto part = streamer.feed(in.data() + off, n);
    streamed.insert(streamed.end(), part.begin(), part.end());
  }
  const auto tail = streamer.flush();
  streamed.insert(streamed.end(), tail.begin(), tail.end());

  // Both paths consume the same input at the same hop, so total length must
  // agree to within a frame regardless of how the input was chunked.
  EXPECT_NEAR(
      static_cast<double>(streamed.size()),
      static_cast<double>(batch.size()),
      2048.0);
}

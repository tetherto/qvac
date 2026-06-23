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

TEST(WsolaTimeStretch, PreservesPitchThroughAmplitudeTransient) {
  // Fixed pitch with a strong amplitude ramp (quiet -> loud). Unnormalized
  // correlation biases the match toward the loud region and smears
  // periodicity; normalized cross-correlation tracks waveform shape, so the
  // fundamental period survives across the whole (amplitude-varying)
  // utterance. The pure-amplitude sine tests don't exercise this.
  const int sr = kSampleRate;
  const float freq = 200.0f; // period 120 samples
  const auto n = static_cast<std::size_t>(1.0f * sr);
  std::vector<float> in(n);
  const float w = 2.0f * 3.14159265358979f * freq / static_cast<float>(sr);
  for (std::size_t i = 0; i < n; ++i) {
    const float env =
        0.1f + 0.9f * (static_cast<float>(i) / static_cast<float>(n));
    in[i] = env * std::sin(w * static_cast<float>(i));
  }

  const auto out = WsolaTimeStretch::apply(in, 0.7f);
  for (const float s : out)
    ASSERT_TRUE(std::isfinite(s));
  const int expected = static_cast<int>(std::lround(sr / freq)); // 120
  EXPECT_NEAR(dominantPeriod(out, expected - 40, expected + 40), expected, 8);
}

TEST(WsolaTimeStretch, StreamingMatchesBatchExactly) {
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

  // Chunking must not change the result at all: the per-frame input gate
  // ensures every frame (and its similarity target) sees real samples, never
  // a zero-filled chunk-boundary tail. So streamed output is bit-identical to
  // batch, not merely the same length. (A length-only check would miss the
  // boundary-seam regression this guards against.)
  ASSERT_EQ(streamed.size(), batch.size());
  for (std::size_t i = 0; i < batch.size(); ++i) {
    ASSERT_FLOAT_EQ(streamed[i], batch[i]) << "mismatch at sample " << i;
  }
}

TEST(WsolaTimeStretch, StreamingMemoryStaysBounded) {
  // Stream a long signal in small chunks and confirm resident memory tracks
  // O(chunk + window), not O(total duration): consumed input and emitted
  // output prefixes must be dropped after each feed().
  const auto in = sine(180.0f, 10.0f); // 240k samples @ 24 kHz
  const float speed = 0.8f;
  const std::size_t chunk = 2400; // ~0.1 s

  WsolaTimeStretch streamer(speed);
  std::vector<float> streamed;
  std::size_t maxResident = 0;
  for (std::size_t off = 0; off < in.size(); off += chunk) {
    const std::size_t n = std::min(chunk, in.size() - off);
    const auto part = streamer.feed(in.data() + off, n);
    streamed.insert(streamed.end(), part.begin(), part.end());
    maxResident = std::max(maxResident, streamer.residentSamples());
  }
  const auto tail = streamer.flush();
  streamed.insert(streamed.end(), tail.begin(), tail.end());

  // A non-compacting implementation would hold the whole utterance
  // (~240k in + ~300k out). Bound generously at one chunk plus a few frames'
  // worth of window/overlap; this is ~20x below the total.
  EXPECT_LT(maxResident, static_cast<std::size_t>(16384))
      << "resident memory grew with utterance length (compaction broken)";

  // Compaction must not change the result.
  const auto batch = WsolaTimeStretch::apply(in, speed);
  ASSERT_EQ(streamed.size(), batch.size());
  for (std::size_t i = 0; i < batch.size(); ++i) {
    ASSERT_FLOAT_EQ(streamed[i], batch[i]) << "mismatch at sample " << i;
  }
}

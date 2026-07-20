// Unit tests for StreamingEnhancer — the stateful wrapper that lets the
// Chatterbox native chunk-streaming path emit LavaSR-enhanced audio chunk by
// chunk (overlap-reprocess with look-ahead margin + crossfade).
//
// The real enhancer is injected as a transform, so these exercise the
// streaming bookkeeping (windowing, hold-back, crossfade, compaction) in
// isolation — no GGUF / ggml — by injecting a known shift-invariant transform.
// For such a transform, with margins covering its support, the streamed output
// must equal the one-shot ("batch") output, so we can assert exact parity (the
// same property test_time_stretch.cpp pins for WSOLA streaming).

#include <cmath>
#include <functional>
#include <random>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/StreamingEnhancer.hpp"

using qvac::ttsggml::StreamingEnhancer;

namespace {

// Shift-invariant linear upsample-by-2 (24k -> 48k stand-in). Temporal support
// is 1 input sample (out[2k+1] reads in[k+1]); the last sample clamps. This is
// exactly what the margins are sized to absorb, so streamed == batch.
std::vector<float> upsample2(const std::vector<float>& in) {
  const std::size_t n = in.size();
  std::vector<float> out(2 * n);
  for (std::size_t k = 0; k < n; ++k) {
    const float next = (k + 1 < n) ? in[k + 1] : in[k];
    out[2 * k] = in[k];
    out[2 * k + 1] = 0.5f * (in[k] + next);
  }
  return out;
}

// A generic (non-integer ratio) linear resampler: outRate/inRate need not be
// integral. Approximately shift-invariant (boundary clamp), used for the
// tolerance-based non-integer test.
std::function<std::vector<float>(const std::vector<float>&)>
linearResampler(int inRate, int outRate) {
  return [inRate, outRate](const std::vector<float>& in) -> std::vector<float> {
    const std::size_t n = in.size();
    if (n == 0)
      return {};
    const double ratio = static_cast<double>(outRate) / inRate;
    const auto m = static_cast<std::size_t>(std::lround(n * ratio));
    std::vector<float> out(m);
    for (std::size_t i = 0; i < m; ++i) {
      const double src = i / ratio;
      const auto a = static_cast<std::size_t>(std::floor(src));
      const double frac = src - static_cast<double>(a);
      const float s0 = in[std::min(a, n - 1)];
      const float s1 = in[std::min(a + 1, n - 1)];
      out[i] = static_cast<float>(s0 + (s1 - s0) * frac);
    }
    return out;
  };
}

std::vector<float> sine(float freqHz, float seconds, int sr) {
  const auto n = static_cast<std::size_t>(seconds * sr);
  std::vector<float> out(n);
  const float w = 2.0f * 3.14159265358979f * freqHz / static_cast<float>(sr);
  for (std::size_t i = 0; i < n; ++i)
    out[i] = std::sin(w * static_cast<float>(i));
  return out;
}

// Feed `in` through a StreamingEnhancer in fixed-size chunks, concatenating the
// per-feed output plus the flush tail.
std::vector<float> streamChunks(
    StreamingEnhancer& se, const std::vector<float>& in, std::size_t chunk) {
  std::vector<float> out;
  for (std::size_t off = 0; off < in.size(); off += chunk) {
    const std::size_t n = std::min(chunk, in.size() - off);
    const auto part = se.feed(in.data() + off, n);
    out.insert(out.end(), part.begin(), part.end());
  }
  const auto tail = se.flush();
  out.insert(out.end(), tail.begin(), tail.end());
  return out;
}

} // namespace

TEST(StreamingEnhancer, StreamingMatchesBatchExactlyUpsample2) {
  const auto in = sine(220.0f, 1.5f, 24000);
  const auto batch = upsample2(in); // one-shot reference

  // Small margins (>= the transform's 1-sample support) so the test is fast;
  // the parity property is independent of the (larger) production defaults.
  StreamingEnhancer se(
      upsample2,
      /*inRate=*/24000,
      /*outRate=*/48000,
      /*contextIn=*/64,
      /*marginIn=*/64,
      /*crossfadeIn=*/16);
  const auto streamed = streamChunks(se, in, /*chunk=*/2400);

  ASSERT_EQ(streamed.size(), batch.size());
  for (std::size_t i = 0; i < batch.size(); ++i)
    ASSERT_FLOAT_EQ(streamed[i], batch[i]) << "mismatch at sample " << i;
}

TEST(StreamingEnhancer, StreamingMatchesBatchWithProductionMargins) {
  // Same parity with the real (0.34 s) margins and ~1 s engine chunks, so the
  // production configuration is exercised, not just the toy one.
  const auto in = sine(180.0f, 6.0f, 24000);
  const auto batch = upsample2(in);

  StreamingEnhancer se(upsample2, 24000, 48000); // default 8192/8192/256
  const auto streamed = streamChunks(se, in, /*chunk=*/24000);

  ASSERT_EQ(streamed.size(), batch.size());
  for (std::size_t i = 0; i < batch.size(); ++i)
    ASSERT_FLOAT_EQ(streamed[i], batch[i]) << "mismatch at sample " << i;
}

TEST(StreamingEnhancer, VariableChunkSizesMatchBatch) {
  std::mt19937 rng(1234);
  std::uniform_real_distribution<float> amp(-1.0f, 1.0f);
  std::vector<float> in(24000 * 2);
  for (auto& s : in)
    s = amp(rng);
  const auto batch = upsample2(in);

  StreamingEnhancer se(upsample2, 24000, 48000, 128, 128, 32);
  std::vector<float> streamed;
  std::mt19937 chunkRng(99);
  std::uniform_int_distribution<int> chunkDist(1, 5000);
  for (std::size_t off = 0; off < in.size();) {
    const std::size_t n =
        std::min<std::size_t>(chunkDist(chunkRng), in.size() - off);
    const auto part = se.feed(in.data() + off, n);
    streamed.insert(streamed.end(), part.begin(), part.end());
    off += n;
  }
  const auto tail = se.flush();
  streamed.insert(streamed.end(), tail.begin(), tail.end());

  ASSERT_EQ(streamed.size(), batch.size());
  for (std::size_t i = 0; i < batch.size(); ++i)
    ASSERT_FLOAT_EQ(streamed[i], batch[i]) << "mismatch at sample " << i;
}

TEST(StreamingEnhancer, ShortUtteranceDrainsOnFlush) {
  // Shorter than the margin: feed() yields nothing, flush() emits the whole
  // (batch-equivalent) result.
  const auto in = sine(300.0f, 0.05f, 24000); // 1200 samples << 8192 margin
  const auto batch = upsample2(in);

  StreamingEnhancer se(upsample2, 24000, 48000); // production margins
  const auto early = se.feed(in.data(), in.size());
  EXPECT_TRUE(early.empty()) << "nothing should finalize within the margin";
  const auto tail = se.flush();

  ASSERT_EQ(tail.size(), batch.size());
  for (std::size_t i = 0; i < batch.size(); ++i)
    ASSERT_FLOAT_EQ(tail[i], batch[i]) << "mismatch at sample " << i;
}

TEST(StreamingEnhancer, NonIntegerRatioTracksBatch) {
  // 24k -> 16k (ratio 2/3): index mapping rounds, so we assert near-parity
  // (length within a couple samples, values close) rather than bit-exact.
  const int inRate = 24000, outRate = 16000;
  const auto in = sine(200.0f, 2.0f, inRate);
  auto fn = linearResampler(inRate, outRate);
  const auto batch = fn(in);

  StreamingEnhancer se(fn, inRate, outRate, 4096, 4096, 256);
  const auto streamed = streamChunks(se, in, /*chunk=*/8000);

  ASSERT_NEAR(
      static_cast<double>(streamed.size()),
      static_cast<double>(batch.size()),
      4.0);
  const std::size_t cmp = std::min(streamed.size(), batch.size());
  double maxDiff = 0.0;
  for (std::size_t i = 0; i < cmp; ++i) {
    ASSERT_TRUE(std::isfinite(streamed[i]));
    maxDiff = std::max(
        maxDiff, std::fabs(static_cast<double>(streamed[i] - batch[i])));
  }
  EXPECT_LT(maxDiff, 1e-3) << "streamed resample drifts from batch";
}

TEST(StreamingEnhancer, MemoryStaysBounded) {
  const auto in = sine(180.0f, 12.0f, 24000);    // 288k input samples
  StreamingEnhancer se(upsample2, 24000, 48000); // 8192 context/margin
  std::vector<float> streamed;
  std::size_t maxResident = 0;
  const std::size_t chunk = 2400;
  for (std::size_t off = 0; off < in.size(); off += chunk) {
    const std::size_t n = std::min(chunk, in.size() - off);
    const auto part = se.feed(in.data() + off, n);
    streamed.insert(streamed.end(), part.begin(), part.end());
    maxResident = std::max(maxResident, se.residentSamples());
  }
  const auto tail = se.flush();
  streamed.insert(streamed.end(), tail.begin(), tail.end());

  // A non-compacting impl would hold all 288k input samples. Bound generously
  // at context + margin + chunk + slack (~19k), ~15x below the total.
  EXPECT_LT(maxResident, static_cast<std::size_t>(8192 + 8192 + 2400 + 4096));

  const auto batch = upsample2(in);
  ASSERT_EQ(streamed.size(), batch.size());
  for (std::size_t i = 0; i < batch.size(); ++i)
    ASSERT_FLOAT_EQ(streamed[i], batch[i]) << "mismatch at sample " << i;
}

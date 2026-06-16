#include <chrono>

#include <gtest/gtest.h>

#include "model-interface/ContinuousBatchScheduler.hpp"

namespace qvac_lib_inference_addon_llama::batching {
namespace {

using std::chrono::milliseconds;

// Per-step timing splits batch throughput into a generation rate (decode
// steps) and a prompt-processing rate (pure-prefill steps), instead of one
// wall-clock figure. llama.cpp's own counters can't do this split under
// continuous batching (every batched step is size > 1, so generation work
// is misfiled as prompt eval), so the scheduler measures it itself.

TEST(RuntimeStatsRates, NoStepsYieldZeroRates) {
  RuntimeStatsSnapshot stats;
  EXPECT_DOUBLE_EQ(stats.decodeTokensPerSecond(), 0.0);
  EXPECT_DOUBLE_EQ(stats.prefillTokensPerSecond(), 0.0);
}

TEST(RuntimeStatsRates, PureDecodeStepsComputeDecodeRate) {
  RuntimeStatsSnapshot stats;
  // Two pure-decode steps: 4 generated tokens over 100 ms total.
  constexpr int numActiveSequences = 2;
  constexpr int prefillTokens = 0;
  constexpr int decodeTokens = 2;
  stats.recordDecodeStep(
      numActiveSequences, prefillTokens, decodeTokens, milliseconds(40));
  stats.recordDecodeStep(
      numActiveSequences, prefillTokens, decodeTokens, milliseconds(60));
  // 1000 * 4 / 100 = 40 tok/s.
  EXPECT_DOUBLE_EQ(stats.decodeTokensPerSecond(), 40.0);
  EXPECT_DOUBLE_EQ(stats.prefillTokensPerSecond(), 0.0);
}

TEST(RuntimeStatsRates, PurePrefillStepsComputePrefillRate) {
  RuntimeStatsSnapshot stats;
  // One pure-prefill step: 100 prompt tokens over 50 ms.
  constexpr int numActiveSequences = 2;
  constexpr int prefillTokens = 100;
  constexpr int decodeTokens = 0;
  stats.recordDecodeStep(
      numActiveSequences, prefillTokens, decodeTokens, milliseconds(50));
  // 1000 * 100 / 50 = 2000 tok/s.
  EXPECT_DOUBLE_EQ(stats.prefillTokensPerSecond(), 2000.0);
  EXPECT_DOUBLE_EQ(stats.decodeTokensPerSecond(), 0.0);
}

TEST(RuntimeStatsRates, MixedStepIsChargedToDecodeNotPrefill) {
  RuntimeStatsSnapshot stats;
  // Pure-prefill step establishes the prefill rate: 100 tok / 50 ms.
  constexpr int numActiveSequences1 = 2;
  constexpr int prefillTokens1 = 100;
  constexpr int decodeTokens1 = 0;
  stats.recordDecodeStep(
      numActiveSequences1, prefillTokens1, decodeTokens1, milliseconds(50));
  // Mixed step: a newcomer feeds 1 prefill token while 3 sequences generate.
  // The whole step (time + its generated tokens) belongs to decode; the
  // piggybacked prefill token must NOT inflate the prefill rate.
  constexpr int numActiveSequences2 = 4;
  constexpr int prefillTokens2 = 1;
  constexpr int decodeTokens2 = 3;
  stats.recordDecodeStep(
      numActiveSequences2, prefillTokens2, decodeTokens2, milliseconds(30));

  // Prefill rate unchanged: still 100 tok / 50 ms = 2000 tok/s. The mixed
  // step's 1 prefill token and 30 ms were charged to decode, not prefill.
  EXPECT_DOUBLE_EQ(stats.prefillTokensPerSecond(), 2000.0);
  // Decode rate: 3 tok / 30 ms = 100 tok/s.
  EXPECT_DOUBLE_EQ(stats.decodeTokensPerSecond(), 100.0);
}

TEST(RuntimeStatsRates, ResetClearsRates) {
  RuntimeStatsSnapshot stats;
  stats.recordDecodeStep(2, 100, 0, milliseconds(50));
  stats.recordDecodeStep(2, 0, 2, milliseconds(40));
  stats.reset();
  EXPECT_DOUBLE_EQ(stats.decodeTokensPerSecond(), 0.0);
  EXPECT_DOUBLE_EQ(stats.prefillTokensPerSecond(), 0.0);
}

} // namespace
} // namespace qvac_lib_inference_addon_llama::batching

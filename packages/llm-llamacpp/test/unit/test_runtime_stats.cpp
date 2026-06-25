#include <chrono>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ContinuousBatchScheduler.hpp"
#include "model-interface/MultiRequestBatcher.hpp"

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

// Minimal `Request` constructed only with the fields `accumulateSlot`
// reads (`generatedTokens.size()` and `prefillTokenCount` — both zero
// here because we're isolating the `thinkingDiscards` aggregation).
Request makeStubRequest() {
  return Request(
      /*rid=*/0, /*toks=*/std::vector<llama_token>{}, /*maxTokens=*/0);
}

// `thinkingDiscards` is the per-slot count of compacted reasoning blocks
// the scheduler aggregates across all slots in a batch — this is the
// counter that surfaces as `RuntimeStats.thinkingBlockDiscards` to the JS
// side. The two tests below pin the sum semantics independent of any
// driver.
TEST(RuntimeStatsAccumulate, AccumulateSlotSumsThinkingDiscards) {
  RuntimeStatsSnapshot stats;
  Request reqA = makeStubRequest();
  Request reqB = makeStubRequest();
  Request reqC = makeStubRequest();

  // (nPast, nSlides, thinkingDiscards, req)
  stats.accumulateSlot(
      /*nPast=*/0, /*nSlides=*/0, /*thinkingDiscards=*/1, reqA);
  stats.accumulateSlot(
      /*nPast=*/0, /*nSlides=*/0, /*thinkingDiscards=*/0, reqB);
  stats.accumulateSlot(
      /*nPast=*/0, /*nSlides=*/0, /*thinkingDiscards=*/2, reqC);

  EXPECT_EQ(stats.thinkingBlockDiscards, 3);
}

TEST(RuntimeStatsAccumulate, AccumulateSlotResetClearsThinkingDiscards) {
  RuntimeStatsSnapshot stats;
  Request req = makeStubRequest();
  stats.accumulateSlot(0, 0, 5, req);
  EXPECT_EQ(stats.thinkingBlockDiscards, 5);

  stats.reset();
  EXPECT_EQ(stats.thinkingBlockDiscards, 0);
}

// promptTokens must reflect tokens ACTUALLY prefilled, not the prompt size
// planned at admission. Every termination path (including cancelSlotLocked)
// funnels through accumulateSlot, so a request cancelled before any prefill
// step ran must contribute zero prompt tokens -- otherwise the documented
// `cacheTokens ~= promptTokens + generatedTokens` invariant breaks (cacheTokens
// comes from the real nPast, here 0).
TEST(RuntimeStatsAccumulate, CancelBeforePrefillCountsZeroPromptTokens) {
  constexpr unsigned maxTokens = 256;
  std::vector<llama_token> prompt(42, 1);
  Request req(/*rid=*/0, std::move(prompt), maxTokens);
  // Admission fixed the planned prompt size, but no prefill step has fed any
  // token yet, so the request is not prefill-complete.
  ASSERT_EQ(req.prefillTokenCount, 42U);
  ASSERT_EQ(req.prefillFedCount, 0U);
  ASSERT_FALSE(req.isPrefillComplete());

  RuntimeStatsSnapshot stats;
  // Same call the cancel path makes via accumulateSlotRuntimeStats: nothing
  // was processed, so nPast and the generated vector are empty.
  stats.accumulateSlot(/*nPast=*/0, /*nSlides=*/0, /*thinkingDiscards=*/0, req);

  EXPECT_EQ(stats.promptTokens, 0);
}

// A request that completed prefill (normal completion, or a cancel after the
// first generated token) must still report the full planned prompt: prefill
// resets prefillFedCount to 0 once complete, so the honest count comes from
// prefillTokenCount in that case.
TEST(RuntimeStatsAccumulate, CompletedPrefillCountsFullPrompt) {
  constexpr unsigned maxTokens = 256;
  std::vector<llama_token> prompt(42, 1);
  Request req(/*rid=*/0, std::move(prompt), maxTokens);
  // Simulate prefill having fed every token: finishPrefillIfComplete clears the
  // pending tokens and resets prefillFedCount to 0 once complete.
  req.pendingPrefillTokens.clear();
  req.prefillFedCount = 0;
  ASSERT_TRUE(req.isPrefillComplete());

  RuntimeStatsSnapshot stats;
  stats.accumulateSlot(
      /*nPast=*/42, /*nSlides=*/0, /*thinkingDiscards=*/0, req);

  EXPECT_EQ(stats.promptTokens, 42);
}

} // namespace
} // namespace qvac_lib_inference_addon_llama::batching

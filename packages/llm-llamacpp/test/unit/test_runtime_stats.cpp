#include <chrono>
#include <thread>
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

TEST(RuntimeStatsRates, TimedDecodeIncludesSynchronizeDurationOnSuccess) {
  llama_batch batch{};
  bool decodeCalled = false;
  bool synchronizeCalled = false;
  const auto synchronizeDelay = milliseconds(25);

  const TimedDecodeResult result = timeDecodeStep(
      nullptr,
      batch,
      [&decodeCalled](llama_context* ctx, llama_batch&) {
        EXPECT_EQ(ctx, nullptr);
        decodeCalled = true;
        return 0;
      },
      [synchronizeDelay, &synchronizeCalled](llama_context* ctx) {
        EXPECT_EQ(ctx, nullptr);
        synchronizeCalled = true;
        std::this_thread::sleep_for(synchronizeDelay);
      });

  EXPECT_EQ(result.rc, 0);
  EXPECT_TRUE(decodeCalled);
  EXPECT_TRUE(synchronizeCalled);
  EXPECT_GE(
      result.duration.count(),
      std::chrono::duration_cast<std::chrono::nanoseconds>(synchronizeDelay)
          .count());
}

TEST(RuntimeStatsRates, TimedDecodeSynchronizesOnDecodeFailure) {
  llama_batch batch{};
  bool synchronizeCalled = false;

  const TimedDecodeResult result = timeDecodeStep(
      nullptr,
      batch,
      [](llama_context*, llama_batch&) { return -1; },
      [&synchronizeCalled](llama_context*) { synchronizeCalled = true; });

  EXPECT_EQ(result.rc, -1);
  EXPECT_TRUE(synchronizeCalled);
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

TEST(RuntimeStatsRates, MixedStepSplitsTimeAndTokensProportionally) {
  RuntimeStatsSnapshot stats;
  // Pure-prefill step establishes an initial prefill rate: 100 tok / 50 ms.
  constexpr int numActiveSequences1 = 2;
  constexpr int prefillTokens1 = 100;
  constexpr int decodeTokens1 = 0;
  stats.recordDecodeStep(
      numActiveSequences1, prefillTokens1, decodeTokens1, milliseconds(50));
  // Mixed step: a newcomer feeds 1 prefill token while 3 sequences generate
  // over 30 ms. The step is split proportionally by token count:
  //   prefill share = 1/(1+3) = 0.25 → prefill += 1 token, +7.5 ms
  //   decode  share = 3/(1+3) = 0.75 → decode  += 3 tokens, +22.5 ms
  constexpr int numActiveSequences2 = 4;
  constexpr int prefillTokens2 = 1;
  constexpr int decodeTokens2 = 3;
  stats.recordDecodeStep(
      numActiveSequences2, prefillTokens2, decodeTokens2, milliseconds(30));

  // Prefill rate: (100 + 1) tok / (50 + 7.5) ms = 101000 / 57.5.
  EXPECT_DOUBLE_EQ(stats.prefillTokensPerSecond(), 1000.0 * 101.0 / 57.5);
  // Decode rate: 3 tok / 22.5 ms = 3000 / 22.5.
  EXPECT_DOUBLE_EQ(stats.decodeTokensPerSecond(), 1000.0 * 3.0 / 22.5);
}

TEST(RuntimeStatsRates, ResetClearsRates) {
  RuntimeStatsSnapshot stats;
  stats.recordDecodeStep(2, 100, 0, milliseconds(50));
  stats.recordDecodeStep(2, 0, 2, milliseconds(40));
  stats.reset();
  EXPECT_DOUBLE_EQ(stats.decodeTokensPerSecond(), 0.0);
  EXPECT_DOUBLE_EQ(stats.prefillTokensPerSecond(), 0.0);
}

// Batch TTFT is sourced from `prefillTimeMs()`. It sums the prefill share
// of every batch step: pure-prefill steps contribute fully, mixed steps
// contribute the prefill-token fraction of their wall-clock. Compactor
// replay decode is excluded because it fires in `onGenerationFinished`,
// outside the scheduler's timed `recordDecodeStep` block — not by any
// gating inside this function.
TEST(RuntimeStatsRates, PrefillTimeMsIncludesProportionalMixedStepShare) {
  RuntimeStatsSnapshot stats;
  EXPECT_DOUBLE_EQ(stats.prefillTimeMs(), 0.0);

  // Two pure-prefill steps: 50 ms + 30 ms = 80 ms.
  stats.recordDecodeStep(
      /*active=*/2, /*prefill=*/100, /*decode=*/0, milliseconds(50));
  stats.recordDecodeStep(
      /*active=*/2, /*prefill=*/40, /*decode=*/0, milliseconds(30));
  EXPECT_DOUBLE_EQ(stats.prefillTimeMs(), 80.0);

  // Mixed step: 1 prefill token piggybacks 3 decode tokens over 25 ms.
  // Prefill share = 1/(1+3) = 0.25, so prefill picks up 25 * 0.25 = 6.25 ms
  // → total prefill time = 80 + 6.25 = 86.25 ms.
  stats.recordDecodeStep(
      /*active=*/3, /*prefill=*/1, /*decode=*/3, milliseconds(25));
  EXPECT_DOUBLE_EQ(stats.prefillTimeMs(), 86.25);

  stats.reset();
  EXPECT_DOUBLE_EQ(stats.prefillTimeMs(), 0.0);
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
      /*nPast=*/0,
      /*nSlides=*/0,
      /*thinkingDiscards=*/1,
      reqA);
  stats.accumulateSlot(
      /*nPast=*/0,
      /*nSlides=*/0,
      /*thinkingDiscards=*/0,
      reqB);
  stats.accumulateSlot(
      /*nPast=*/0,
      /*nSlides=*/0,
      /*thinkingDiscards=*/2,
      reqC);

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
  stats.accumulateSlot(
      /*nPast=*/0,
      /*nSlides=*/0,
      /*thinkingDiscards=*/0,
      req);

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
      /*nPast=*/42,
      /*nSlides=*/0,
      /*thinkingDiscards=*/0,
      req);

  EXPECT_EQ(stats.promptTokens, 42);
}

// Per-request observed stats: end-to-end figures as the submitting caller
// experienced them (queue wait + shared-GPU decode), computed from the
// request's wall-clock stamps at drain. Distinct from the snapshot rates
// above, which are whole-scheduler aggregates.

TEST(ObservedRequestStats, ComputesTtftAndObservedTps) {
  constexpr unsigned maxTokens = 256;
  std::vector<llama_token> prompt(10, 1);
  Request req(/*rid=*/0, std::move(prompt), maxTokens);
  req.pendingPrefillTokens.clear();
  req.prefillFedCount = 0;
  ASSERT_TRUE(req.isPrefillComplete());

  const auto enqueued = std::chrono::steady_clock::time_point{};
  req.firstTokenAt = enqueued + milliseconds(100);
  req.lastTokenAt = enqueued + milliseconds(1100);
  req.generatedTokens.assign(11, 7);

  const ObservedRequestStats observed = computeObservedStats(enqueued, req);
  // Enqueue -> first token.
  EXPECT_DOUBLE_EQ(observed.ttftMs, 100.0);
  // 10 inter-token gaps over 1 s = 10 tok/s observed.
  EXPECT_DOUBLE_EQ(observed.genTps, 10.0);
  EXPECT_EQ(observed.generatedTokens, 11);
  EXPECT_EQ(observed.promptTokens, 10);
}

TEST(ObservedRequestStats, NoSampledTokenYieldsZeroTimingFigures) {
  constexpr unsigned maxTokens = 256;
  std::vector<llama_token> prompt(5, 1);
  Request req(/*rid=*/0, std::move(prompt), maxTokens);

  const ObservedRequestStats observed =
      computeObservedStats(std::chrono::steady_clock::time_point{}, req);
  EXPECT_DOUBLE_EQ(observed.ttftMs, 0.0);
  EXPECT_DOUBLE_EQ(observed.genTps, 0.0);
  EXPECT_EQ(observed.generatedTokens, 0);
  // Nothing was fed yet: the partial prefill count is 0.
  EXPECT_EQ(observed.promptTokens, 0);
}

TEST(ObservedRequestStats, GroupAggregateAveragesActiveAndSumsCounts) {
  // Two active requests and one that never sampled a token (cancelled before
  // generation): rates/TTFT average only over the active two, counts sum over
  // all three.
  const std::vector<ObservedRequestStats> group{
      {.ttftMs = 100.0,
       .genTps = 10.0,
       .generatedTokens = 11,
       .promptTokens = 10},
      {.ttftMs = 300.0,
       .genTps = 30.0,
       .generatedTokens = 31,
       .promptTokens = 20},
      {.ttftMs = 0.0, .genTps = 0.0, .generatedTokens = 0, .promptTokens = 5}};

  const ObservedRequestStats agg = aggregateObservedStats(group);
  EXPECT_DOUBLE_EQ(agg.ttftMs, 200.0);
  EXPECT_DOUBLE_EQ(agg.genTps, 20.0);
  EXPECT_EQ(agg.generatedTokens, 42);
  EXPECT_EQ(agg.promptTokens, 35);
}

TEST(ObservedRequestStats, GroupAggregateOfNothingIsZero) {
  const ObservedRequestStats agg = aggregateObservedStats({});
  EXPECT_DOUBLE_EQ(agg.ttftMs, 0.0);
  EXPECT_DOUBLE_EQ(agg.genTps, 0.0);
  EXPECT_EQ(agg.generatedTokens, 0);
  EXPECT_EQ(agg.promptTokens, 0);
}

TEST(ObservedRequestStats, SingleTokenHasTtftButNoRate) {
  constexpr unsigned maxTokens = 256;
  Request req(/*rid=*/0, std::vector<llama_token>{1, 2}, maxTokens);
  req.pendingPrefillTokens.clear();
  req.prefillFedCount = 0;

  const auto enqueued = std::chrono::steady_clock::time_point{};
  req.firstTokenAt = enqueued + milliseconds(50);
  req.lastTokenAt = req.firstTokenAt;
  req.generatedTokens.assign(1, 7);

  const ObservedRequestStats observed = computeObservedStats(enqueued, req);
  EXPECT_DOUBLE_EQ(observed.ttftMs, 50.0);
  // A single token spans no interval; no honest rate exists.
  EXPECT_DOUBLE_EQ(observed.genTps, 0.0);
  EXPECT_EQ(observed.generatedTokens, 1);
}

} // namespace
} // namespace qvac_lib_inference_addon_llama::batching

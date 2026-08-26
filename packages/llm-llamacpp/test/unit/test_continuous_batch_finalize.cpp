// Terminal lifecycle-hook routing for ContinuousBatchScheduler. Guards the
// SequenceDriver contract that every error/cancel termination runs
// onCancel/onGenerationFinished (and thus TextLlmContext's post-generation
// policy work, e.g. thinking-block compaction), not a bare
// onSequenceEnd flush.
#include <algorithm>
#include <functional>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ContinuousBatchScheduler.hpp"
#include "model-interface/MultiRequestBatcher.hpp"
#include "model-interface/SequenceDriver.hpp"

namespace {

using qvac_lib_inference_addon_llama::batching::finalizeTerminalDriver;
using qvac_lib_inference_addon_llama::batching::StopReason;

/// SequenceDriver stub that records which terminal hooks fire. Every other
/// method is an inert stub: this test only exercises the finalize routing.
class RecordingDriver : public SequenceDriver {
public:
  std::vector<std::string> calls;
  GenerationStopReason terminalReason = GenerationStopReason::None;

  [[nodiscard]] llama_pos getNPast() const override { return 0; }
  PrefillPlan preparePrefill(
      const std::vector<common_chat_msg>&, const std::vector<common_chat_tool>&,
      const std::vector<std::vector<uint8_t>>&,
      const std::vector<PlannedMedia>&, bool, bool) override {
    return {};
  }
  llama_pos evalMediaSegment(size_t, llama_pos pos) override { return pos; }
  void onPrefillComplete(llama_pos, size_t) override {}
  void syncPosition(llama_pos) override {}
  SequenceStepResult onLogitsReady(
      int, unsigned, const std::function<void(const std::string&)>&,
      LlamaBatch*) override {
    return {};
  }
  void onSequenceEnd(const std::function<void(const std::string&)>&) override {
    calls.emplace_back("onSequenceEnd");
  }
  [[nodiscard]] bool onGenerationFinished(
      const std::function<void(const std::string&)>&,
      GenerationStopReason reason = GenerationStopReason::None) override {
    calls.emplace_back("onGenerationFinished");
    terminalReason = reason;
    return rollbackOk;
  }
  [[nodiscard]] bool
  onCancel(const std::function<void(const std::string&)>&) override {
    calls.emplace_back("onCancel");
    return rollbackOk;
  }
  bool rollbackOk = true;
  [[nodiscard]] bool loadCache(const std::string&) override { return false; }
  void saveCache(const std::string&) const override {}

  [[nodiscard]] bool fired(const std::string& hook) const {
    return std::find(calls.begin(), calls.end(), hook) != calls.end();
  }
};

const std::function<void(const std::string&)> kNoCallback;

} // namespace

/// Decode-error finalization must run the generation-complete hook
/// (onCancel/onGenerationFinished), which is what triggers TextLlmContext's
/// post-generation policy work (e.g. thinking-block compaction). The pre-fix
/// path called only onSequenceEnd, which flushes UTF-8 and skips that policy
/// work, leaving KV state inconsistent.
TEST(ContinuousBatchFinalize, DecodeErrorRunsGenerationCompleteHook) {
  RecordingDriver driver;
  (void)finalizeTerminalDriver(
      driver, StopReason::DecodeError, /*prefillOnly=*/false, kNoCallback);

  EXPECT_TRUE(driver.fired("onCancel") || driver.fired("onGenerationFinished"))
      << "decode-error finalization must fire onCancel/onGenerationFinished so "
         "the post-generation policy work runs; instead it fired only "
         "onSequenceEnd (UTF-8 flush)";
}

/// Cancelled terminations route through onCancel (regression guard for the
/// shared mapping).
TEST(ContinuousBatchFinalize, CancelledRunsCancelHook) {
  RecordingDriver driver;
  (void)finalizeTerminalDriver(
      driver, StopReason::Cancelled, /*prefillOnly=*/false, kNoCallback);

  EXPECT_TRUE(driver.fired("onCancel"));
}

/// Natural end-of-generation routes through onGenerationFinished.
TEST(ContinuousBatchFinalize, NaturalFinishRunsGenerationFinishedHook) {
  RecordingDriver driver;
  (void)finalizeTerminalDriver(
      driver, StopReason::Finished, /*prefillOnly=*/false, kNoCallback);

  EXPECT_TRUE(driver.fired("onGenerationFinished"));
  EXPECT_EQ(driver.terminalReason, GenerationStopReason::None);
}

/// A slot whose context window filled must reach the driver as
/// ContextOverflow, not as the per-sequence cap. Collapsing the two makes a
/// full context indistinguishable from a prediction-limit cutoff for every
/// batched caller.
TEST(ContinuousBatchFinalize, ContextOverflowPropagatesContextOverflow) {
  RecordingDriver driver;
  (void)finalizeTerminalDriver(
      driver, StopReason::ContextOverflow, /*prefillOnly=*/false, kNoCallback);

  EXPECT_TRUE(driver.fired("onGenerationFinished"));
  EXPECT_EQ(driver.terminalReason, GenerationStopReason::ContextOverflow);
}

// `SequenceLimit` is unreachable in production (nothing produces it since the
// batched full-window stop became `ContextOverflow`); it is pinned here so the
// classifier keeps covering it if a producer ever returns.
TEST(GenerationStopReason, IdentifiesReasoningTruncations) {
  EXPECT_TRUE(
      isKnownReasoningTruncation(GenerationStopReason::PredictionLimit));
  EXPECT_TRUE(isKnownReasoningTruncation(GenerationStopReason::SequenceLimit));
  EXPECT_TRUE(
      isKnownReasoningTruncation(GenerationStopReason::ContextOverflow));
  EXPECT_FALSE(isKnownReasoningTruncation(GenerationStopReason::None));
  EXPECT_FALSE(isKnownReasoningTruncation(GenerationStopReason::Eos));
  EXPECT_FALSE(isKnownReasoningTruncation(GenerationStopReason::Antiprompt));
}

TEST(GenerationStopReason, RetainsReasoningTruncationAfterRollback) {
  EXPECT_EQ(
      stopReasonAfterRequestRollback(GenerationStopReason::ContextOverflow),
      GenerationStopReason::ContextOverflow);
  EXPECT_EQ(
      stopReasonAfterRequestRollback(GenerationStopReason::PredictionLimit),
      GenerationStopReason::PredictionLimit);
  EXPECT_EQ(
      stopReasonAfterRequestRollback(GenerationStopReason::None),
      GenerationStopReason::None);
}

/// A prefill-only slot never generated, so it only flushes via onSequenceEnd
/// and must not run the generation-complete trim.
TEST(ContinuousBatchFinalize, PrefillOnlyOnlyFlushes) {
  RecordingDriver driver;
  (void)finalizeTerminalDriver(
      driver, StopReason::Finished, /*prefillOnly=*/true, kNoCallback);

  EXPECT_TRUE(driver.fired("onSequenceEnd"));
  EXPECT_FALSE(driver.fired("onGenerationFinished"));
  EXPECT_FALSE(driver.fired("onCancel"));
}

/// `finalizeTerminalDriver` must forward the driver's rollback-ok signal so
/// the scheduler can skip `saveCache` when a recurrent full-state restore was
/// refused. Cancelled / DecodeError paths report through `onCancel`; natural
/// generation finalization can also report a rollback failure when generation
/// was truncated mid-reasoning.
TEST(ContinuousBatchFinalize, CancelForwardsRollbackFailure) {
  RecordingDriver driver;
  driver.rollbackOk = false;
  EXPECT_FALSE(finalizeTerminalDriver(
      driver, StopReason::Cancelled, /*prefillOnly=*/false, kNoCallback));
}

TEST(ContinuousBatchFinalize, CancelForwardsRollbackSuccess) {
  RecordingDriver driver;
  driver.rollbackOk = true;
  EXPECT_TRUE(finalizeTerminalDriver(
      driver, StopReason::Cancelled, /*prefillOnly=*/false, kNoCallback));
}

TEST(ContinuousBatchFinalize, NaturalFinishForwardsRollbackFailure) {
  RecordingDriver driver;
  driver.rollbackOk = false;
  EXPECT_FALSE(finalizeTerminalDriver(
      driver, StopReason::Finished, /*prefillOnly=*/false, kNoCallback));
}

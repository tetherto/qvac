// Terminal lifecycle-hook routing for ContinuousBatchScheduler. Guards the
// SequenceDriver contract that every error/cancel termination runs
// onCancel/onGenerationFinished (and thus TextLlmContext::
// onGenerationCompletePolicy, the tools_compact tool-region trim), not a bare
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

  [[nodiscard]] llama_pos getNPast() const override { return 0; }
  [[nodiscard]] int32_t getNSlides() const override { return 0; }
  void validatePromptPolicy(
      const std::vector<common_chat_msg>&, const std::vector<common_chat_tool>&,
      const PromptLayout&, bool) const override {}
  std::vector<llama_token> preparePrefill(
      const std::vector<common_chat_msg>&, const std::vector<common_chat_tool>&,
      bool, bool) override {
    return {};
  }
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
  void onGenerationFinished(
      const std::function<void(const std::string&)>&) override {
    calls.emplace_back("onGenerationFinished");
  }
  void onCancel(const std::function<void(const std::string&)>&) override {
    calls.emplace_back("onCancel");
  }
  [[nodiscard]] bool loadCache(const std::string&, llama_pos) override {
    return false;
  }
  void saveCache(const std::string&) const override {}

  [[nodiscard]] bool fired(const std::string& hook) const {
    return std::find(calls.begin(), calls.end(), hook) != calls.end();
  }
};

const std::function<void(const std::string&)> kNoCallback;

} // namespace

/// Decode-error finalization must run the generation-complete hook
/// (onCancel/onGenerationFinished), which is what triggers
/// TextLlmContext::onGenerationCompletePolicy and the tools_compact tool-region
/// trim. The pre-fix path called only onSequenceEnd, which flushes UTF-8 and
/// skips the trim, leaving tool-compaction KV state inconsistent.
TEST(ContinuousBatchFinalize, DecodeErrorRunsGenerationCompleteHook) {
  RecordingDriver driver;
  finalizeTerminalDriver(
      driver, StopReason::DecodeError, /*prefillOnly=*/false, kNoCallback);

  EXPECT_TRUE(driver.fired("onCancel") || driver.fired("onGenerationFinished"))
      << "decode-error finalization must fire onCancel/onGenerationFinished so "
         "onGenerationCompletePolicy runs; instead it fired only onSequenceEnd "
         "(UTF-8 flush), skipping the tools_compact trim";
}

/// Cancelled terminations route through onCancel (regression guard for the
/// shared mapping).
TEST(ContinuousBatchFinalize, CancelledRunsCancelHook) {
  RecordingDriver driver;
  finalizeTerminalDriver(
      driver, StopReason::Cancelled, /*prefillOnly=*/false, kNoCallback);

  EXPECT_TRUE(driver.fired("onCancel"));
}

/// Natural end-of-generation routes through onGenerationFinished.
TEST(ContinuousBatchFinalize, NaturalFinishRunsGenerationFinishedHook) {
  RecordingDriver driver;
  finalizeTerminalDriver(
      driver, StopReason::Finished, /*prefillOnly=*/false, kNoCallback);

  EXPECT_TRUE(driver.fired("onGenerationFinished"));
}

/// A prefill-only slot never generated, so it only flushes via onSequenceEnd
/// and must not run the generation-complete trim.
TEST(ContinuousBatchFinalize, PrefillOnlyOnlyFlushes) {
  RecordingDriver driver;
  finalizeTerminalDriver(
      driver, StopReason::Finished, /*prefillOnly=*/true, kNoCallback);

  EXPECT_TRUE(driver.fired("onSequenceEnd"));
  EXPECT_FALSE(driver.fired("onGenerationFinished"));
  EXPECT_FALSE(driver.fired("onCancel"));
}

// slideCapable must be driver-aware. A multimodal slot never slides its
// KV-cache window (it holds media cells fixed), so the scheduler must keep
// the per-slot token cap enforced for it. A text slot slides, so it may
// touch the cap and recover. This guards the scheduler decision feeding
// Request::slideCapable / Request::exceededLimit.
#include <functional>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ContinuousBatchScheduler.hpp"
#include "model-interface/MultiRequestBatcher.hpp"
#include "model-interface/SequenceDriver.hpp"

namespace {

using qvac_lib_inference_addon_llama::batching::computeSlideCapable;
using qvac_lib_inference_addon_llama::batching::Request;

/// SequenceDriver stub whose only meaningful behavior is supportsSliding.
/// Every other method is an inert stub.
class SlideCapabilityDriver : public SequenceDriver {
public:
  explicit SlideCapabilityDriver(bool slides) : slides_(slides) {}

  [[nodiscard]] llama_pos getNPast() const override { return 0; }
  [[nodiscard]] int32_t getNSlides() const override { return 0; }
  [[nodiscard]] bool supportsSliding() const override { return slides_; }
  void validatePromptPolicy(
      const std::vector<common_chat_msg>&, const std::vector<common_chat_tool>&,
      const PromptLayout&, bool) const override {}
  PrefillPlan preparePrefill(
      const std::vector<common_chat_msg>&, const std::vector<common_chat_tool>&,
      const std::vector<std::vector<uint8_t>>&,
      const std::vector<PlannedMedia>&, bool, bool) override {
    return {};
  }
  void onPrefillComplete(llama_pos, size_t) override {}
  void syncPosition(llama_pos) override {}
  SequenceStepResult onLogitsReady(
      int, unsigned, const std::function<void(const std::string&)>&,
      LlamaBatch*) override {
    return {};
  }
  void onSequenceEnd(const std::function<void(const std::string&)>&) override {}
  void onGenerationFinished(
      const std::function<void(const std::string&)>&) override {}
  void onCancel(const std::function<void(const std::string&)>&) override {}
  [[nodiscard]] bool loadCache(const std::string&, llama_pos) override {
    return false;
  }
  void saveCache(const std::string&) const override {}

private:
  bool slides_;
};

/// Build a generating request that has reached its per-slot ceiling and ask
/// exceededLimit whether the slot is capped.
bool slotCappedAtCeiling(bool slideCapable) {
  constexpr unsigned maxTokens = 2;
  Request req(
      0,
      std::vector<llama_token>{100},
      maxTokens,
      /*initialPos=*/0,
      slideCapable);
  req.prefillFedCount = 1;
  req.generatedTokens.push_back(200);
  req.currentPos = static_cast<llama_pos>(maxTokens);
  return req.exceededLimit();
}

} // namespace

/// A multimodal driver does not slide, so the scheduler must NOT grant it a
/// cap waiver even with sliding configured and a generation step. The slot
/// must stay capped at the ceiling; otherwise its position runs away
/// unbounded (the bug).
TEST(SlideCapableCapability, MtmdSlotIsNotSlideCapableAndStaysCapped) {
  SlideCapabilityDriver mtmd(/*slides=*/false);
  const bool slideCapable =
      computeSlideCapable(mtmd, /*slideConfigured=*/true, /*isPrefill=*/false);

  EXPECT_FALSE(slideCapable)
      << "a driver that cannot slide must not be granted a cap waiver";
  EXPECT_TRUE(slotCappedAtCeiling(slideCapable))
      << "a non-sliding slot at its ceiling must be capped; instead it was "
         "left alive expecting a slide that never happens, so its position "
         "advances past the per-slot cap unbounded";
}

/// A text driver slides, so with sliding configured during generation it may
/// touch the cap and recover on the next step.
TEST(SlideCapableCapability, TextSlotIsSlideCapableWhenConfigured) {
  SlideCapabilityDriver text(/*slides=*/true);
  const bool slideCapable =
      computeSlideCapable(text, /*slideConfigured=*/true, /*isPrefill=*/false);

  EXPECT_TRUE(slideCapable);
  EXPECT_FALSE(slotCappedAtCeiling(slideCapable));
}

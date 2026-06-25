// The per-sequence generation budget must be enforced against KV cells, not
// only positions. For M-RoPE media a prompt occupies more KV cells than
// positions (promptKvSize > promptSize), so a request can pass the
// position-based budget (promptSize + n_predict <= cap) while its KV-cell
// budget (promptKvSize + n_predict) overruns the per-slot KV-cache. This
// guards the admission decision feeding ContinuousBatchScheduler::submitLocked.
#include <gtest/gtest.h>

#include "model-interface/ContinuousBatchScheduler.hpp"

namespace {

using qvac_lib_inference_addon_llama::batching::generationBudgetExceeded;

} // namespace

/// MTMD hole: a media-heavy prompt whose KV-cell span leaves no room for
/// n_predict must be rejected, even though its position span does. With the
/// position-only budget the request slips through and overruns the slot's
/// KV-cache during generation.
TEST(GenerationBudgetAdmission, KvCellBudgetRejectsMediaHeavyPrompt) {
  constexpr unsigned perSeqMaxTokens = 100;
  constexpr unsigned promptSize = 40;
  constexpr unsigned promptKvSize = 95;
  constexpr int nPredict = 16;

  // Position span fits: 40 + 16 = 56 <= 100.
  EXPECT_FALSE(generationBudgetExceeded(
      promptSize, promptSize, nPredict, perSeqMaxTokens))
      << "position-only budget should fit for this prompt";

  // KV-cell span overruns: 95 + 16 = 111 > 100.
  EXPECT_TRUE(generationBudgetExceeded(
      promptSize, promptKvSize, nPredict, perSeqMaxTokens))
      << "KV-CELL BUDGET HOLE: prompt of " << promptKvSize << " KV cells + "
      << nPredict << " generated tokens exceeds the per-sequence cap "
      << perSeqMaxTokens
      << ", but the generation budget was enforced only against positions ("
      << promptSize << " + " << nPredict << ") and admitted the request";
}

/// A text prompt (promptKvSize == promptSize) whose prompt + n_predict fits the
/// cap is admitted; the KV-cell check must not over-reject the common case.
TEST(GenerationBudgetAdmission, FittingPromptIsAdmitted) {
  constexpr unsigned perSeqMaxTokens = 100;
  constexpr unsigned promptSize = 40;
  constexpr int nPredict = 16;

  EXPECT_FALSE(generationBudgetExceeded(
      promptSize, promptSize, nPredict, perSeqMaxTokens));
}

/// n_predict <= 0 means "no scheduler cap"; the batcher ceiling governs, so the
/// generation budget is never exceeded regardless of prompt size.
TEST(GenerationBudgetAdmission, NonPositiveNPredictNeverExceeds) {
  constexpr unsigned perSeqMaxTokens = 100;
  constexpr unsigned promptKvSize = 200;

  EXPECT_FALSE(
      generationBudgetExceeded(promptKvSize, promptKvSize, 0, perSeqMaxTokens));
  EXPECT_FALSE(generationBudgetExceeded(
      promptKvSize, promptKvSize, -1, perSeqMaxTokens));
}

/// Driver-side prefill admission (PR #2543 comments 3451907561 / 3451908540).
/// A prefill-only request may exactly fill the per-slot window: it generates
/// nothing afterward, so a fully occupied window is fine. The drivers used to
/// reject it with a hard-coded `>= ceiling` that ignored the prefill flag,
/// even though the scheduler admits exactly-full prefill with strict `>`.
TEST(ContextWindowAdmission, PrefillOnlyMayExactlyFillWindow) {
  constexpr llama_pos ceiling = 100;
  EXPECT_FALSE(
      exceedsContextWindow(ceiling, ceiling, /*isPrefillOnlyRequest=*/true))
      << "exactly-full prefill-only must be admitted (it never generates)";
  EXPECT_TRUE(
      exceedsContextWindow(ceiling + 1, ceiling, /*isPrefillOnlyRequest=*/true))
      << "strictly over the window is still rejected";
}

/// A request that will generate needs at least one free slot for the next
/// token, so a window that is exactly full is already too many.
TEST(ContextWindowAdmission, GenerationNeedsAFreeSlot) {
  constexpr llama_pos ceiling = 100;
  EXPECT_TRUE(
      exceedsContextWindow(ceiling, ceiling, /*isPrefillOnlyRequest=*/false))
      << "exactly-full leaves no room to generate the next token";
  EXPECT_FALSE(exceedsContextWindow(
      ceiling - 1, ceiling, /*isPrefillOnlyRequest=*/false))
      << "one free slot is enough to start generating";
}

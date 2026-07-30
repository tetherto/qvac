#include <cstdint>
#include <optional>
#include <string>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "model-interface/ContextSlider.hpp"
#include "model-interface/ReasoningBlockCompactor.hpp"
#include "model-interface/ReasoningRecoveryHelpers.hpp"
#include "model-interface/ToolsCompactController.hpp"
#include "utils/ReasoningRollbackState.hpp"
#include "utils/ReasoningSnapshotPolicy.hpp"

using qvac_lib_inference_addon_llama::ReasoningBlockCompactor;
using qvac_lib_inference_addon_llama::reasoning_recovery::CancelRecoveryHooks;
using qvac_lib_inference_addon_llama::reasoning_recovery::
    rollbackCancelledRequest;
using qvac_lib_inference_addon_llama::utils::reasoningBoundaryDecision;
using qvac_lib_inference_addon_llama::utils::ReasoningBoundaryDecision;
using qvac_lib_inference_addon_llama::utils::ReasoningRollbackState;
using qvac_lib_inference_addon_llama::utils::shouldCaptureReasoningBoundary;

// Unit coverage for the hybrid / recurrent reasoning replay seam.
//
// End-of-prefill snapshots are taken at the boundary between prefill
// and generation. For force-open templates the opener already lives in
// the snapshot; for generated-opener templates the compactor seeds the
// sampled opener token span into the replay buffer via
// `recordPreReasoningToken` so the restored SSM state is still balanced
// after compaction. Either way the replay buffer must carry the
// matching close marker so the resulting `<think>...</think>` shape is
// balanced. These tests pin:
//   1. the unconditional append primitive (`appendPostReasoningToken`),
//   2. the compactor wrappers (`recordCloseMarkerForReplay` and
//      `recordPreReasoningToken`) feature gates and open-span
//      invariants,
//   3. the success path against a seeded boundary snapshot.

TEST(ReasoningSnapshotPolicy, CapturesOnlyForForcedOpenRecurrentReasoning) {
  EXPECT_TRUE(shouldCaptureReasoningBoundary(
      /*removeThinkingFromContext=*/true,
      /*reasoningEnabled=*/true,
      /*thinkingForcedOpen=*/true,
      /*closeMarkerSingleToken=*/true));
  EXPECT_EQ(
      reasoningBoundaryDecision(
          /*removeThinkingFromContext=*/true,
          /*reasoningEnabled=*/true,
          /*thinkingForcedOpen=*/true,
          /*closeMarkerSingleToken=*/true),
      ReasoningBoundaryDecision::Capture);
}

TEST(ReasoningSnapshotPolicy, CapturesGeneratedOpenRecurrentReasoning) {
  // Generated-opener recurrent turns are now supported: the caller
  // seeds the sampled opener token span (including any preamble)
  // into the replay buffer alongside the close marker, so the
  // restored end-of-prefill prefix no longer needs to contain
  // `<think>`. The policy must return `Capture` so the boundary
  // snapshot is taken and the seed-and-replay path can fire.
  EXPECT_TRUE(shouldCaptureReasoningBoundary(
      /*removeThinkingFromContext=*/true,
      /*reasoningEnabled=*/true,
      /*thinkingForcedOpen=*/false,
      /*closeMarkerSingleToken=*/true));
  EXPECT_EQ(
      reasoningBoundaryDecision(
          /*removeThinkingFromContext=*/true,
          /*reasoningEnabled=*/true,
          /*thinkingForcedOpen=*/false,
          /*closeMarkerSingleToken=*/true),
      ReasoningBoundaryDecision::Capture);
}

TEST(ReasoningSnapshotPolicy, SkipsWhenFeatureOrReasoningGateIsClosed) {
  EXPECT_FALSE(shouldCaptureReasoningBoundary(
      /*removeThinkingFromContext=*/false,
      /*reasoningEnabled=*/true,
      /*thinkingForcedOpen=*/true,
      /*closeMarkerSingleToken=*/true));
  EXPECT_FALSE(shouldCaptureReasoningBoundary(
      /*removeThinkingFromContext=*/true,
      /*reasoningEnabled=*/false,
      /*thinkingForcedOpen=*/true,
      /*closeMarkerSingleToken=*/true));
}

// Recurrent replay seeds `postReasoningTokens_` with the single sampled
// token that flips `updateReasoningBuffer` out of `inside_reasoning`. If
// the close tag tokenises to more than one piece, that seed captures
// only the tail piece and the restored SSM state ends with an unbalanced
// `<think>` opener. The policy MUST reject the boundary snapshot in that
// case so `remove_thinking_from_context` hard-fails instead of leaving
// reasoning tokens in cache or silently corrupting recurrent state.
TEST(ReasoningSnapshotPolicy, RejectsWhenCloseMarkerIsMultiToken) {
  EXPECT_FALSE(shouldCaptureReasoningBoundary(
      /*removeThinkingFromContext=*/true,
      /*reasoningEnabled=*/true,
      /*thinkingForcedOpen=*/true,
      /*closeMarkerSingleToken=*/false));
  EXPECT_EQ(
      reasoningBoundaryDecision(
          /*removeThinkingFromContext=*/true,
          /*reasoningEnabled=*/true,
          /*thinkingForcedOpen=*/true,
          /*closeMarkerSingleToken=*/false),
      ReasoningBoundaryDecision::UnsupportedMultiTokenClose);
}

TEST(
    ReasoningSnapshotRecovery,
    DisabledRemovalUsesTokenRollbackWithoutSnapshot) {
  ReasoningRollbackState rollback;
  llama_pos removed = 0;
  bool tokenRollbackCompleted = false;
  const bool ok = rollbackCancelledRequest({
      .labelTag = "[Test]",
      .ctx = nullptr,
      .seqId = 0,
      .reasoningRemovalEnabled = false,
      .currentPos = 10,
      .preRequestPos = 5,
      .rollback = rollback,
      .onSnapshotRestored = [](llama_pos) {},
      .onSnapshotRestoreFailed = [](llama_pos) {},
      .onMissingSnapshotAdvanced = []() {},
      .removeLastNTokens = [&](llama_pos delta) { removed = delta; },
      .onTokensRolledBack = [&]() { tokenRollbackCompleted = true; },
  });

  EXPECT_TRUE(ok);
  EXPECT_EQ(removed, 5);
  EXPECT_TRUE(tokenRollbackCompleted);
}

TEST(ReasoningSnapshotRecovery, EnabledRemovalMissingSnapshotFailsSafely) {
  ReasoningRollbackState rollback;
  bool missingSnapshotReported = false;
  bool tokenRollbackAttempted = false;
  const bool ok = rollbackCancelledRequest({
      .labelTag = "[Test]",
      .ctx = nullptr,
      .seqId = 0,
      .reasoningRemovalEnabled = true,
      .currentPos = 10,
      .preRequestPos = 5,
      .rollback = rollback,
      .onSnapshotRestored = [](llama_pos) {},
      .onSnapshotRestoreFailed = [](llama_pos) {},
      .onMissingSnapshotAdvanced = [&]() { missingSnapshotReported = true; },
      .removeLastNTokens = [&](llama_pos) { tokenRollbackAttempted = true; },
      .onTokensRolledBack = []() {},
  });

  EXPECT_FALSE(ok);
  EXPECT_TRUE(missingSnapshotReported);
  EXPECT_FALSE(tokenRollbackAttempted);
}

TEST(ReasoningRollbackStateAppend, AppendsRegardlessOfCaptureFlag) {
  ReasoningRollbackState rollback;
  EXPECT_FALSE(rollback.isCapturingPostReasoning());
  rollback.appendPostReasoningToken(42);
  rollback.appendPostReasoningToken(7);
  ASSERT_EQ(rollback.postReasoningTokenCount(), 2u);
  EXPECT_EQ(rollback.seededPostReasoningCount(), 2u);
  EXPECT_EQ(rollback.postReasoningTokens()[0], 42);
  EXPECT_EQ(rollback.postReasoningTokens()[1], 7);
}

TEST(ReasoningRollbackStateAppend, SkipsNullToken) {
  ReasoningRollbackState rollback;
  rollback.appendPostReasoningToken(LLAMA_TOKEN_NULL);
  EXPECT_EQ(rollback.postReasoningTokenCount(), 0u);
  EXPECT_EQ(rollback.seededPostReasoningCount(), 0u);
}

TEST(ReasoningRollbackStateAppend, PreservesOrderWithCapturedTokens) {
  // The close marker is seeded via `appendPostReasoningToken` BEFORE
  // capture flips on; everything sampled after lands via
  // `recordPostReasoningToken`. The replay must concatenate them in
  // [close-marker, ...post-close] order so the SSM advance is balanced.
  ReasoningRollbackState rollback;
  rollback.appendPostReasoningToken(/*closeMarker=*/100);
  rollback.startPostReasoningCapture(true);
  rollback.recordPostReasoningToken(/*newline=*/198);
  rollback.recordPostReasoningToken(/*answer=*/2500);

  ASSERT_EQ(rollback.postReasoningTokenCount(), 3u);
  EXPECT_EQ(rollback.postReasoningTokens()[0], 100);
  EXPECT_EQ(rollback.postReasoningTokens()[1], 198);
  EXPECT_EQ(rollback.postReasoningTokens()[2], 2500);
}

TEST(ReasoningRollbackStateAppend, ResetClearsBuffer) {
  ReasoningRollbackState rollback;
  rollback.appendPostReasoningToken(1);
  rollback.appendPostReasoningToken(2);
  ASSERT_EQ(rollback.postReasoningTokenCount(), 2u);
  rollback.reset();
  EXPECT_EQ(rollback.postReasoningTokenCount(), 0u);
  EXPECT_EQ(rollback.seededPostReasoningCount(), 0u);
}

TEST(
    ReasoningRollbackStateClip,
    PreservesSeededCloseMarkerWithEmptyCapturedTail) {
  // `compact()` passes `pos - end` as the captured-tail cap. When no
  // post-close tokens were sampled (e.g. EOS hit immediately after
  // `</think>`), that cap is zero. The seeded close marker MUST
  // survive — dropping it would replay an unbalanced
  // `<think>\n` + answer-tail recurrent state on the next turn.
  ReasoningRollbackState rollback;
  rollback.appendPostReasoningToken(/*closeMarker=*/100);
  ASSERT_EQ(rollback.seededPostReasoningCount(), 1u);

  rollback.clipPostReasoningTokens(/*maxCapturedTail=*/0);
  ASSERT_EQ(rollback.postReasoningTokenCount(), 1u);
  EXPECT_EQ(rollback.postReasoningTokens()[0], 100);
}

TEST(ReasoningRollbackStateClip, PreservesMultipleSeededStructuralTokens) {
  // Future callers may seed more than one structural token before
  // capture flips on. Clipping with an empty live tail must preserve
  // the entire seeded prefix, not just the first token.
  ReasoningRollbackState rollback;
  rollback.appendPostReasoningToken(/*closeMarker=*/100);
  rollback.appendPostReasoningToken(/*structuralNewline=*/198);
  rollback.startPostReasoningCapture(true);
  rollback.recordPostReasoningToken(/*capturedTail=*/2500);
  ASSERT_EQ(rollback.seededPostReasoningCount(), 2u);

  rollback.clipPostReasoningTokens(/*maxCapturedTail=*/0);

  ASSERT_EQ(rollback.postReasoningTokenCount(), 2u);
  EXPECT_EQ(rollback.postReasoningTokens()[0], 100);
  EXPECT_EQ(rollback.postReasoningTokens()[1], 198);
}

TEST(ReasoningRollbackStateClip, KeepsSeededPrefixAndCapsCapturedTail) {
  // Replay buffer is [close_marker, t0, t1, t2]. Live cache only has
  // two post-close tokens left (tools-compact trimmed one). Clip cap
  // is the captured-tail length (2), not the total. The close marker
  // stays; only the last captured token is dropped.
  ReasoningRollbackState rollback;
  rollback.appendPostReasoningToken(/*closeMarker=*/100);
  rollback.startPostReasoningCapture(true);
  rollback.recordPostReasoningToken(/*t0=*/198);
  rollback.recordPostReasoningToken(/*t1=*/2500);
  rollback.recordPostReasoningToken(/*t2=*/9999);
  ASSERT_EQ(rollback.postReasoningTokenCount(), 4u);

  rollback.clipPostReasoningTokens(/*maxCapturedTail=*/2);

  ASSERT_EQ(rollback.postReasoningTokenCount(), 3u);
  EXPECT_EQ(rollback.postReasoningTokens()[0], 100);
  EXPECT_EQ(rollback.postReasoningTokens()[1], 198);
  EXPECT_EQ(rollback.postReasoningTokens()[2], 2500);
}

TEST(ReasoningRollbackStateClip, ClipsAllCapturedTokensWhenNoSeededPrefix) {
  // Baseline for the old shape: if the buffer has only captured tail
  // tokens, cap 0 still means drop everything.
  ReasoningRollbackState rollback;
  rollback.startPostReasoningCapture(true);
  rollback.recordPostReasoningToken(1);
  rollback.recordPostReasoningToken(2);
  ASSERT_EQ(rollback.seededPostReasoningCount(), 0u);
  ASSERT_EQ(rollback.postReasoningTokenCount(), 2u);

  rollback.clipPostReasoningTokens(/*maxCapturedTail=*/0);

  EXPECT_EQ(rollback.postReasoningTokenCount(), 0u);
}

TEST(ReasoningRollbackStateClip, ClearPostReasoningResetsSeededCount) {
  // Seeded count must follow the buffer lifecycle: a fresh inference
  // (post-clear) must not see a stale count that would let the next
  // clip preserve nonexistent tokens.
  ReasoningRollbackState rollback;
  rollback.appendPostReasoningToken(100);
  ASSERT_EQ(rollback.seededPostReasoningCount(), 1u);
  rollback.clearPostReasoning();
  EXPECT_EQ(rollback.seededPostReasoningCount(), 0u);

  rollback.startPostReasoningCapture(true);
  rollback.recordPostReasoningToken(1);
  rollback.recordPostReasoningToken(2);
  ASSERT_EQ(rollback.postReasoningTokenCount(), 2u);
  rollback.clipPostReasoningTokens(/*maxCapturedTail=*/0);
  EXPECT_EQ(rollback.postReasoningTokenCount(), 0u);
}

namespace {

// Helper that wires up the compactor with the gates exposed by its
// public API. The boundary snapshot is left empty by default; callers
// that need `hasReasoningBoundary()` to be true seed a sentinel
// file-backed snapshot through the rollback test seam.
struct CompactorFixture {
  ReasoningRollbackState rollback;
  // Tools-compact controller is unused by `recordCloseMarkerForReplay`
  // — its slide notifier only fires from `compact()`. Constructed with
  // an empty profile so it stays in its disabled state for the lifetime
  // of the fixture.
  ToolsCompactController tools{std::nullopt};
  ReasoningBlockCompactor compactor{rollback, tools};
};

void seedReasoningBoundary(CompactorFixture& fx, llama_pos nPast) {
  fx.rollback.seedReasoningBoundaryForTesting(nPast);
  ASSERT_TRUE(fx.rollback.hasReasoningBoundary())
      << "test setup must establish the replay boundary before opening a span";
}

} // namespace

TEST(ReasoningBlockCompactorReplaySeed, NoOpWhenRemoveThinkingOff) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(false);
  fx.compactor.setReasoningEnabled(true);
  fx.compactor.recordCloseMarkerForReplay(/*closeMarker=*/42);
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
}

TEST(ReasoningBlockCompactorReplaySeed, NoOpWhenReasoningDisabled) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(false);
  fx.compactor.recordCloseMarkerForReplay(42);
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
}

TEST(ReasoningBlockCompactorReplaySeed, PureAttentionUsesReplayBuffer) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);
  fx.compactor.recordCloseMarkerForReplay(42);
  ASSERT_EQ(fx.rollback.postReasoningTokenCount(), 1u);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[0], 42);
}

TEST(ReasoningBlockCompactorReplaySeed, NoOpWhenBoundaryNotCaptured) {
  // All feature gates open but no end-of-prefill snapshot exists
  // (e.g. capture underflowed). Recording the close marker would be
  // unsafe — there is nothing to restore to, so compaction will be
  // skipped anyway. The seed must not silently accumulate in that case.
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  ASSERT_FALSE(fx.rollback.hasReasoningBoundary());
  fx.compactor.recordCloseMarkerForReplay(42);
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
}

TEST(ReasoningBlockCompactorReplaySeed, AppendsWhenAllGatesAndBoundaryPresent) {
  // Simulate a successful end-of-prefill capture by seeding a non-empty
  // snapshot payload directly. The compactor only needs
  // `hasReasoningBoundary()` to be true to know the recurrent restore
  // path is viable — the snapshot's exact bytes are irrelevant for
  // seeding the replay buffer.
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);
  ASSERT_TRUE(fx.rollback.hasReasoningBoundary());

  fx.compactor.recordCloseMarkerForReplay(/*closeMarker=*/123);
  ASSERT_EQ(fx.rollback.postReasoningTokenCount(), 1u);
  EXPECT_EQ(fx.rollback.seededPostReasoningCount(), 1u);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[0], 123);
}

TEST(ReasoningBlockCompactorReplaySeed, SkipsNullCloseMarker) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/5);
  ASSERT_TRUE(fx.rollback.hasReasoningBoundary());

  fx.compactor.recordCloseMarkerForReplay(LLAMA_TOKEN_NULL);
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
  EXPECT_EQ(fx.rollback.seededPostReasoningCount(), 0u);
}

// ---------------------------------------------------------------------------
// `recordPreReasoningToken` seed contract
// ---------------------------------------------------------------------------
//
// Generated-opener recurrent turns seed every token sampled between
// end-of-prefill and the open-detection flip into the replay buffer via
// `recordPreReasoningToken` so the restored snapshot + replay lands in a
// balanced `<think>...</think>` state (see the compactor header comment
// on `recordPreReasoningToken` for full rationale). The tests below mirror
// the `recordCloseMarkerForReplay` gates so future callers can trust that
// pre-reasoning seeding is a NO-OP on any configuration where the replay
// path is not going to fire.

TEST(ReasoningBlockCompactorReplaySeed, PreReasoningNoOpWhenRemoveThinkingOff) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(false);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/5);
  fx.compactor.recordPreReasoningToken(/*preToken=*/198);
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
}

TEST(ReasoningBlockCompactorReplaySeed, PreReasoningNoOpWhenReasoningDisabled) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(false);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/5);
  fx.compactor.recordPreReasoningToken(198);
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
}

TEST(ReasoningBlockCompactorReplaySeed, PureAttentionSeedsPreReasoningTokens) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);
  fx.compactor.recordPreReasoningToken(198);
  ASSERT_EQ(fx.rollback.postReasoningTokenCount(), 1u);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[0], 198);
}

TEST(
    ReasoningBlockCompactorReplaySeed,
    PreReasoningNoOpWhenBoundaryNotCaptured) {
  // Snapshot never captured (e.g. capture underflowed before generation
  // started). Accumulating tokens in the replay buffer would be dead
  // state — `compact()` cannot restore without a boundary.
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  ASSERT_FALSE(fx.rollback.hasReasoningBoundary());
  fx.compactor.recordPreReasoningToken(198);
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
}

TEST(ReasoningBlockCompactorReplaySeed, PreReasoningSkipsNullToken) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/5);
  fx.compactor.recordPreReasoningToken(LLAMA_TOKEN_NULL);
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
  EXPECT_EQ(fx.rollback.seededPostReasoningCount(), 0u);
}

TEST(
    ReasoningBlockCompactorReplaySeed,
    PreReasoningSeedsInSampleOrderBeforeCloseMarker) {
  // Simulates a generated-opener recurrent turn where the model emits
  // some preamble (`\n`) followed by a multi-token opener (`<think>` =>
  // 2 pieces), then eventually a close marker. Replay buffer must be
  // `[preamble, opener_piece_0, opener_piece_1, close]` so the SSM
  // advance is balanced after boundary restore.
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);
  ASSERT_TRUE(fx.rollback.hasReasoningBoundary());

  fx.compactor.recordPreReasoningToken(/*preamble=*/198);
  fx.compactor.recordPreReasoningToken(/*openerPiece0=*/50);
  fx.compactor.recordPreReasoningToken(/*openerPiece1=*/51);
  fx.compactor.recordCloseMarkerForReplay(/*closeMarker=*/100);

  ASSERT_EQ(fx.rollback.postReasoningTokenCount(), 4u);
  EXPECT_EQ(fx.rollback.seededPostReasoningCount(), 4u);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[0], 198);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[1], 50);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[2], 51);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[3], 100);
}

TEST(ReasoningBlockCompactorReplaySeed, PreReasoningNoOpAfterOpenSpanRecorded) {
  // Full-lifecycle regression: the caller invokes
  // `recordPreReasoningToken` for every sampled token where
  // `reasoningState_.inside_reasoning == false`. That predicate is
  // TRUE both before the opener AND after `updateReasoningBuffer`
  // flips inside_reasoning back to false on the close marker.
  // Without gating on the open span, every post-close answer token
  // would be appended twice — once via `recordPostReasoningToken`
  // (captured tail) and once via `recordPreReasoningToken` (seeded
  // prefix) — and the recurrent replay would decode the answer twice
  // through the SSM.
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);

  // Pre-open: preamble + opener piece seeded.
  fx.compactor.recordPreReasoningToken(/*preamble=*/198);
  fx.compactor.recordPreReasoningToken(/*opener=*/50);

  // Open flip fires -> span recorded.
  fx.compactor.setOpenSpan(/*start=*/15);
  ASSERT_TRUE(fx.compactor.hasOpenSpan());

  // Close flip fires: close seeded, span end committed, capture on.
  fx.compactor.recordCloseMarkerForReplay(/*closeMarker=*/100);
  fx.compactor.requestCloseCapture();
  fx.compactor.onCloseCommitted(/*pos=*/20);
  ASSERT_TRUE(fx.rollback.isCapturingPostReasoning());

  // Post-close answer token: caller invokes BOTH
  // `recordPostReasoningToken` (captured tail) AND
  // `recordPreReasoningToken` (because `inside_reasoning == false`
  // again). The pre-reasoning call MUST no-op — otherwise the
  // answer token lands twice.
  fx.rollback.recordPostReasoningToken(/*answer=*/2500);
  fx.compactor.recordPreReasoningToken(/*answer=*/2500);

  ASSERT_EQ(fx.rollback.postReasoningTokenCount(), 4u);
  EXPECT_EQ(fx.rollback.seededPostReasoningCount(), 3u);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[0], 198);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[1], 50);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[2], 100);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[3], 2500);
}

TEST(
    ReasoningBlockCompactorReplaySeed,
    PreReasoningSeedSurvivesClipWhenNoCapturedTail) {
  // Combined preamble + opener + close seed with an empty captured tail:
  // `clipPostReasoningTokens(0)` MUST preserve the full seeded prefix.
  // Regression against a future clip cap that only accounts for the
  // close marker.
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);

  fx.compactor.recordPreReasoningToken(/*preamble=*/198);
  fx.compactor.recordPreReasoningToken(/*opener=*/50);
  fx.compactor.recordCloseMarkerForReplay(/*closeMarker=*/100);
  ASSERT_EQ(fx.rollback.seededPostReasoningCount(), 3u);

  fx.rollback.clipPostReasoningTokens(/*maxCapturedTail=*/0);

  ASSERT_EQ(fx.rollback.postReasoningTokenCount(), 3u);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[0], 198);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[1], 50);
  EXPECT_EQ(fx.rollback.postReasoningTokens()[2], 100);
}

// Pin the close-capture handshake contract used by every close-marker
// site (normal buffer-transition path AND EOS-substitution path):
// `onCloseCommitted` only records the span end after a prior
// `requestCloseCapture()`. The EOS-substitution path in
// `TextLlmContext::handleReasoningEOS` previously called
// `onCloseCommitted` directly without flipping the flag, which silently
// dropped the close position and left `compactThinkSpan` to bail at
// `end < 0`. These tests document the contract so any future caller
// regression surfaces here rather than as a "multi-turn compaction
// quietly stops working" integration failure.
TEST(ReasoningBlockCompactorCloseCommit, IsNoOpWithoutPriorRequest) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  seedReasoningBoundary(fx, /*nPast=*/10);
  fx.compactor.setOpenSpan(/*start=*/10);
  ASSERT_TRUE(fx.compactor.hasOpenSpan());
  ASSERT_FALSE(fx.compactor.hasPendingCloseCapture());

  // No `requestCloseCapture()` ahead of this — the flag never flipped,
  // so the commit is dropped and the span end stays unset.
  fx.compactor.onCloseCommitted(/*pos=*/42);
  EXPECT_FALSE(fx.compactor.hasCapturedCloseSpanForTesting());
}

TEST(ReasoningBlockCompactorCloseCommit, RecordsSpanEndAfterRequest) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  seedReasoningBoundary(fx, /*nPast=*/10);
  fx.compactor.setOpenSpan(/*start=*/10);
  ASSERT_TRUE(fx.compactor.hasOpenSpan());

  fx.compactor.requestCloseCapture();
  ASSERT_TRUE(fx.compactor.hasPendingCloseCapture());
  fx.compactor.onCloseCommitted(/*pos=*/42);
  EXPECT_TRUE(fx.compactor.hasCapturedCloseSpanForTesting());
  EXPECT_FALSE(fx.compactor.hasPendingCloseCapture());
}

// ============================================================================
// Failure contract — uniform hard-fail
// ============================================================================
//
// Any inability to remove the reasoning span from cache is a hard
// failure under the default-on `remove_thinking_from_context` contract
// (PR #2813). `snapshotAtPrefillBoundary` still throws
// `qvac_errors::StatusError` on boundary-capture failure (recovery
// happens one level up in `snapshotForRecurrentRollback`), but
// `compact()` reports failures via `Outcome::Kind::FailedKvIntact` /
// `Outcome::Kind::FailedKvWiped` so callers can choose the correct
// live-KV recovery (pre-request rollback vs full reset) before
// rethrowing. In every failure path `thinkingBlockDiscards` never
// bumps for the failed drop.
//
// Coverage:
//   * Boundary-capture failure (`snapshotAtPrefillBoundary` on
//     `ctx == nullptr`, which short-reads inside
//     `captureReasoningBoundary`).
//   * Hybrid restore failure (`compact()` on `ctx == nullptr` with a
//     seeded boundary) reports `FailedKvWiped`.
//   * Defensive no-boundary compactor entry — hybrid model, no
//     boundary snapshot captured — must cleanly no-op (span never
//     opens on recurrent+no-boundary; `compact()` returns `NoOp`).
//   * Non-failure no-op paths do NOT throw and do NOT bump discards.
//
// The symmetric replay throw shape is exercised end-to-end by the
// driver-level integration tests; the compactor unit fixture cannot
// reach it without either a test seam on `replayPostReasoning` or a
// real `llama_context`.

TEST(
    ReasoningBlockCompactorFailureStats,
    BoundaryCaptureFailureThrowsAndLeavesNoStaleState) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);

  // `ctx == nullptr` short-circuits `captureReasoningBoundary` to
  // return false, which now throws under the hard-fail contract.
  ASSERT_FALSE(fx.rollback.hasReasoningBoundary());
  EXPECT_THROW(
      {
        fx.compactor.snapshotAtPrefillBoundary(
            /*ctx=*/nullptr, /*seqId=*/0, /*pos=*/10, "[Test]");
      },
      qvac_errors::StatusError);

  // No spurious boundary or discard bookkeeping on failure.
  EXPECT_FALSE(fx.rollback.hasReasoningBoundary());
  EXPECT_EQ(fx.compactor.blockDiscards(), 0);
}

TEST(
    ReasoningBlockCompactorFailureStats,
    RestoreFailureThrowsAndClearsInternalState) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);

  constexpr llama_pos kSnapshotPos = 10;
  constexpr llama_pos kSpanStart = 15;
  constexpr llama_pos kSpanEnd = 20;
  constexpr llama_pos kLivePos = 25;

  fx.rollback.seedReasoningBoundaryForTesting(kSnapshotPos);
  ASSERT_TRUE(fx.rollback.hasReasoningBoundary());

  fx.compactor.setOpenSpan(kSpanStart);
  fx.compactor.requestCloseCapture();
  fx.compactor.onCloseCommitted(kSpanEnd);
  ASSERT_TRUE(fx.compactor.hasCapturedCloseSpanForTesting());

  ASSERT_EQ(fx.compactor.blockDiscards(), 0);

  // `ctx == nullptr` -> `restoreRecurrentState` returns false ->
  // `restoreReasoningBoundary` returns false -> `compact()` reports
  // `FailedKvWiped` with a populated failureMessage so the caller can
  // rethrow with matching context.
  const auto outcome = fx.compactor.compact(
      /*ctx=*/nullptr, /*seqId=*/0, kLivePos, "[Test]");
  EXPECT_EQ(
      outcome.kind, ReasoningBlockCompactor::Outcome::Kind::FailedKvWiped);
  EXPECT_FALSE(outcome.failureMessage.empty());

  // No successful drop counted.
  EXPECT_EQ(fx.compactor.blockDiscards(), 0);

  // The `ResetGuard` in `compact()` runs on the failure path too,
  // so per-inference state (span, boundary snapshot, replay buffer)
  // must be fully cleared. Without this the next inference's
  // `snapshotAtPrefillBoundary` no-ops on the stale boundary and the
  // driver would replay stale post-reasoning tokens.
  EXPECT_FALSE(fx.compactor.hasOpenSpan());
  EXPECT_FALSE(fx.rollback.hasReasoningBoundary());
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
}

TEST(
    ReasoningBlockCompactorFailureStats,
    NextCompactAfterRestoreFailureIsCleanNoOp) {
  // The reviewer's "next request starts from a clean/reset state"
  // invariant, exercised at the compactor level: after a failure
  // outcome, a fresh compact() on the same instance MUST not carry
  // over the failed inference's span or boundary.
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);

  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);
  fx.compactor.setOpenSpan(/*start=*/15);
  fx.compactor.requestCloseCapture();
  fx.compactor.onCloseCommitted(/*pos=*/20);
  const auto failed = fx.compactor.compact(
      /*ctx=*/nullptr, /*seqId=*/0, /*pos=*/25, "[Test]");
  ASSERT_EQ(failed.kind, ReasoningBlockCompactor::Outcome::Kind::FailedKvWiped);

  // Simulating "next turn": no new span, no seeded boundary.
  const auto outcome = fx.compactor.compact(
      /*ctx=*/nullptr, /*seqId=*/0, /*pos=*/0, "[Test]");
  EXPECT_EQ(outcome.kind, ReasoningBlockCompactor::Outcome::Kind::NoOp);
  EXPECT_EQ(fx.compactor.blockDiscards(), 0);
}

// Defensive no-boundary regression: `ReasoningSnapshotPolicy` still
// hard-fails multi-token close-marker templates before generation and
// `snapshotAtPrefillBoundary` throws on capture underflow, but if a
// future caller bypasses those sites and reaches the compactor with
// recurrent memory but no boundary snapshot, `setOpenSpan` must still
// refuse to record a span so `compact()` does not wipe the sequence
// through its defensive no-boundary branch.
TEST(
    ReasoningBlockCompactorFailureStats,
    RecurrentNoBoundarySpanSkipsCompactionAsDefensiveNoOp) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  ASSERT_FALSE(fx.rollback.hasReasoningBoundary());

  fx.compactor.setOpenSpan(/*start=*/15);
  EXPECT_FALSE(fx.compactor.hasOpenSpan())
      << "recurrent + no boundary must not record a span — otherwise "
         "compact() will hit its defensive branch and wipe the sequence";

  fx.compactor.requestCloseCapture();
  fx.compactor.onCloseCommitted(/*pos=*/20);
  EXPECT_FALSE(fx.compactor.hasCapturedCloseSpanForTesting());

  const auto outcome = fx.compactor.compact(
      /*ctx=*/nullptr, /*seqId=*/0, /*pos=*/25, "[Test]");
  EXPECT_EQ(outcome.kind, ReasoningBlockCompactor::Outcome::Kind::NoOp)
      << "recurrent no-boundary defensive path must be a clean no-op, "
         "not FailedKvWiped";
  EXPECT_TRUE(outcome.failureMessage.empty());
  EXPECT_EQ(fx.compactor.blockDiscards(), 0);
}

TEST(ReasoningBlockCompactorFailureStats, NoOpOutcomesDoNotThrow) {
  // Non-failure no-op paths where the live cursor is already before the
  // reasoning span leave the cache untouched and MUST NOT throw. Without this
  // guard, a tail-eraser that removed the entire span before compaction ran
  // would be spuriously failed.
  //
  // This test covers the open-ended shape only after the live cursor has
  // already moved before the span. Resident open-ended spans are covered below
  // because they must compact or hard-fail, not return NoOp.

  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);
  fx.compactor.setOpenSpan(/*start=*/15);
  // No requestCloseCapture / onCloseCommitted -> end stays -1.
  ASSERT_FALSE(fx.compactor.hasCapturedCloseSpanForTesting());

  const auto outcome = fx.compactor.compact(
      /*ctx=*/nullptr, /*seqId=*/0, /*pos=*/10, "[Test]");
  EXPECT_EQ(outcome.kind, ReasoningBlockCompactor::Outcome::Kind::NoOp);
  EXPECT_EQ(fx.compactor.blockDiscards(), 0);
}

TEST(ReasoningBlockCompactorReplayOnly, Dsv4LikeFailureNeverSlidesMemory) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/35);

  fx.compactor.setOpenSpan(/*start=*/35);
  fx.compactor.requestCloseCapture();
  fx.compactor.onCloseCommitted(/*pos=*/127);
  for (llama_pos pos = 127; pos < 710; ++pos) {
    fx.compactor.recordPostReasoningToken(/*id=*/42);
  }

  const auto outcome = fx.compactor.compact(
      /*ctx=*/nullptr, /*seqId=*/0, /*pos=*/710, "[Test]");

  EXPECT_EQ(
      outcome.kind, ReasoningBlockCompactor::Outcome::Kind::FailedKvWiped);
  EXPECT_FALSE(fx.compactor.hasOpenSpan());
  EXPECT_FALSE(fx.rollback.hasReasoningBoundary());
  EXPECT_EQ(fx.rollback.postReasoningTokenCount(), 0u);
}

TEST(
    ReasoningBlockCompactorOpenSpan,
    UniversalReplayHardFailsResidentOpenSpanWithoutClose) {
  CompactorFixture fx;
  fx.compactor.setRemoveThinkingFromContext(true);
  fx.compactor.setReasoningEnabled(true);
  fx.rollback.seedReasoningBoundaryForTesting(/*nPast=*/10);

  fx.compactor.setOpenSpan(/*start=*/15);
  ASSERT_FALSE(fx.compactor.hasCapturedCloseSpanForTesting());

  const auto outcome = fx.compactor.compact(
      /*ctx=*/nullptr, /*seqId=*/0, /*pos=*/20, "[Test]");

  EXPECT_EQ(outcome.kind, ReasoningBlockCompactor::Outcome::Kind::FailedKvWiped)
      << "open-ended reasoning span must hard-fail instead of "
         "leaking resident reasoning tokens";
  EXPECT_NE(
      outcome.failureMessage.find("open reasoning span"), std::string::npos);
  EXPECT_EQ(fx.compactor.blockDiscards(), 0);
  EXPECT_FALSE(fx.compactor.hasOpenSpan());
}

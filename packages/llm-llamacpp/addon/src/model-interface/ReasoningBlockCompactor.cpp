#include "ReasoningBlockCompactor.hpp"

#include <algorithm>
#include <cstddef>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "../addon/LlmErrors.hpp"
#include "../utils/LoggingMacros.hpp"
#include "../utils/ReasoningRollbackState.hpp"
#include "inference-addon-cpp/Logger.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_llama {

namespace {

// Best-effort sequence wipe used before throwing on the hybrid
// restore/replay failure path. On success live memory is empty for
// `seqId`, matching the caller's post-catch reset onto pos=0. Silent
// no-op when `ctx` is null (unit-test seam) or `llama_get_memory`
// returns null — the throw still fires below so the caller reacts
// appropriately, but we can't reason further about live state.
//
// `llama_memory_seq_rm(-1, -1)` is documented never to fail for a
// full-range delete (only partial ranges over recurrent memory can
// reject), but log a warning if it ever does so operators see the
// stale state rather than debugging silent cache-key drift later.
void clearSeqOnFailure(::llama_context* ctx, llama_seq_id seqId) noexcept {
  if (ctx == nullptr) {
    return;
  }
  auto* mem = llama_get_memory(ctx);
  if (mem == nullptr) {
    return;
  }
  const bool cleared = llama_memory_seq_rm(mem, seqId, -1, -1);
  if (!cleared) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[ReasoningBlockCompactor] llama_memory_seq_rm(-1,-1) refused "
            "full-range wipe on seqId=%d before hard-fail throw; caller's "
            "post-catch reset may not match live memory\n",
            static_cast<int>(seqId)));
  }
}

class DefaultReasoningRewindOps final : public IReasoningRewindOps {
public:
  bool restoreBoundary(
      utils::ReasoningRollbackState& rollback, ::llama_context* ctx,
      llama_seq_id seqId) const override {
    return rollback.restoreReasoningBoundary(ctx, seqId);
  }
  bool replayPostReasoning(
      utils::ReasoningRollbackState& rollback, ::llama_context* ctx,
      llama_seq_id seqId) const override {
    return rollback.replayPostReasoning(ctx, seqId);
  }
};
} // namespace

const IReasoningRewindOps& defaultReasoningRewindOps() {
  static const DefaultReasoningRewindOps ops;
  return ops;
}

ReasoningBlockCompactor::ReasoningBlockCompactor(
    utils::ReasoningRollbackState& rollback)
    : rollback_(rollback) {}

void ReasoningBlockCompactor::setOpenSpan(llama_pos start) {
  // `start < 0` only for degenerate templates whose entire rendered
  // prompt is the forced-open suffix; drop the span and leave the
  // tokens in cache.
  if (!removeThinkingFromContext_ || !reasoningEnabled_ || start < 0) {
    return;
  }
  // Compaction restores an end-of-prefill boundary and replays, on every
  // model, so a boundary is required. The policy and capture sites fail
  // unsupported requests before this point, so this guard is only a
  // defensive backstop for future callers that bypass them and would
  // otherwise drive `compact()` into its no-boundary `FailedKvWiped` branch.
  if (!rollback_.hasReasoningBoundary()) {
    return;
  }
  if (thinkSpan_.has_value()) {
    return;
  }
  thinkSpan_ = std::make_pair(start, static_cast<llama_pos>(-1));
}

void ReasoningBlockCompactor::recordCloseMarkerForReplay(llama_token id) {
  if (!removeThinkingFromContext_ || !reasoningEnabled_) {
    return;
  }
  if (!rollback_.hasReasoningBoundary()) {
    return;
  }
  rollback_.appendPostReasoningToken(id);
}

void ReasoningBlockCompactor::recordCloseMarkerForReplay(
    const std::vector<llama_token>& ids) {
  for (const llama_token id : ids) {
    recordCloseMarkerForReplay(id);
  }
}

void ReasoningBlockCompactor::recordPreReasoningToken(llama_token id) {
  if (!removeThinkingFromContext_ || !reasoningEnabled_) {
    return;
  }
  if (!rollback_.hasReasoningBoundary()) {
    return;
  }
  // Only meaningful before the reasoning open flip. Callers invoke this
  // for every sampled token where `reasoningState_.inside_reasoning`
  // is false, which is TRUE both before the opener AND after
  // `updateReasoningBuffer` flips back on the close marker. Without
  // this guard every post-close answer token would be appended twice:
  // once by `recordPostReasoningTokenIfActive` (captured tail) and once
  // here (seeded prefix), and the recurrent replay would decode the
  // answer through the SSM twice.
  if (thinkSpan_.has_value()) {
    return;
  }
  // Same primitive as the close marker: append to the seeded prefix
  // so `clipPostReasoningTokens` will preserve these tokens across a
  // tail trim. Order in `postReasoningTokens_` is
  // `[pre-reasoning..., close, captured tail...]`, matching the
  // desired replay sequence after the boundary snapshot is restored.
  rollback_.appendPostReasoningToken(id);
}

void ReasoningBlockCompactor::onCloseCommitted(llama_pos pos) {
  if (!pendingThinkCloseCapture_) {
    return;
  }
  pendingThinkCloseCapture_ = false;
  if (!removeThinkingFromContext_ || !thinkSpan_.has_value()) {
    return;
  }
  if (thinkSpan_->second < 0) {
    thinkSpan_->second = pos;
  }
  // Begin capturing post-reasoning tokens for replay against the restored
  // boundary. Every model replays now, so this is gated only on a boundary
  // having been captured.
  rollback_.startPostReasoningCapture(rollback_.hasReasoningBoundary());
}

void ReasoningBlockCompactor::snapshotAtPrefillBoundary(
    ::llama_context* ctx, llama_seq_id seqId, llama_pos pos,
    const char* labelTag) {
  if (!removeThinkingFromContext_ || !reasoningEnabled_) {
    return;
  }
  if (rollback_.hasReasoningBoundary()) {
    return; // already anchored this inference
  }
  if (!needsRecurrentSnapshot_) {
    // Pure attention: the boundary is just a position. Rewinding to it is a
    // tail trim, so there is no state to serialize and nothing that can fail.
    rollback_.captureReasoningBoundaryPosition(pos);
    return;
  }
  if (!rollback_.captureReasoningBoundary(ctx, seqId, pos)) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s thinking-block compaction failed: could not snapshot "
            "sequence state at prefill boundary (pos=%d, seqId=%d); "
            "hard-failing the request so a subsequent turn does not "
            "observe the reasoning span in KV/SSM cache\n",
            labelTag,
            pos,
            seqId));
    // Without the boundary snapshot the recurrent path cannot compact
    // safely at end-of-generation. Live memory is untouched at this
    // point (the capture is read-only on failure), so no seq wipe is
    // needed here — the caller unwinds via its pre-request rollback
    // anchor. Fail hard rather than delivering an answer with the
    // reasoning span still resident in cache.
    throw qvac_errors::StatusError(
        errors::ADDON_ID,
        errors::toString(errors::FailedToDecode),
        string_format(
            "%s ReasoningBlockCompactor::snapshotAtPrefillBoundary: "
            "captureReasoningBoundary underflowed (pos=%d, seqId=%d)",
            labelTag,
            pos,
            seqId));
  }
}

ReasoningBlockCompactor::Outcome ReasoningBlockCompactor::compact(
    ::llama_context* ctx, llama_seq_id seqId, llama_pos pos,
    const char* labelTag) {
  // RAII-style cleanup so every early return drops the per-inference
  // rollback buffers and span. The original sites in `TextLlmContext`
  // and `MtmdLlmContext` had identical guards; centralised here so
  // there is no drift.
  struct ResetGuard {
    ReasoningBlockCompactor* self;
    ~ResetGuard() {
      self->thinkSpan_.reset();
      self->rollback_.clearReasoningBoundary();
      self->rollback_.clearPostReasoning();
    }
  } guard{this};

  const IReasoningRewindOps& rewindOps = rewindOpsOverride_ != nullptr
                                             ? *rewindOpsOverride_
                                             : defaultReasoningRewindOps();

  Outcome out;
  if (!removeThinkingFromContext_ || !thinkSpan_.has_value()) {
    return out;
  }
  const llama_pos start = thinkSpan_->first;
  const llama_pos recordedEnd = thinkSpan_->second;
  out.spanStart = start;
  out.spanEnd = recordedEnd;

  // A missing close marker is only a no-op if the live cursor has already
  // moved before the open span. Otherwise `[start, pos)` is still resident
  // reasoning and must be removed or hard-failed under the strict cleanup
  // contract.
  const bool openEnded = recordedEnd < 0;
  if (openEnded) {
    if (start >= pos) {
      return out;
    }
    // Pure attention can still handle this: rewinding to the boundary and
    // replaying the pre-reasoning tokens drops the unfinished span outright,
    // and there is no answer to preserve because generation never left it.
    // Recurrent replay has no balanced state to land in, so it hard-fails.
    if (needsRecurrentSnapshot_) {
      QLOG_IF(
          Priority::WARNING,
          string_format(
              "%s thinking-block compaction: recurrent path cannot compact "
              "open reasoning span [%d, %d) without a captured close marker "
              "(pos=%d, seqId=%d); wiping sequence and hard-failing so "
              "reasoning does not remain in cache\n",
              labelTag,
              start,
              pos,
              pos,
              seqId));
      clearSeqOnFailure(ctx, seqId);
      out.kind = Outcome::Kind::FailedKvWiped;
      out.failureMessage = string_format(
          "%s ReasoningBlockCompactor::compact: recurrent / hybrid "
          "open reasoning span [%d, %d) has no captured close marker "
          "(pos=%d, seqId=%d)",
          labelTag,
          start,
          pos,
          pos,
          seqId);
      return out;
    }
  } else if (recordedEnd <= start) {
    // Degenerate spans have no resident reasoning range to remove. This is the
    // single validation backstop for close-capture sites — none validate
    // `end > start` themselves.
    return out;
  }
  // `recordedEnd > pos` means a tail-eraser shrank the cache past the
  // recorded close marker.
  //
  // Two sub-cases:
  //   * `start >= pos`: the whole reasoning span was already dropped
  //     by the tail-eraser; nothing resident, genuine NoOp.
  //   * `start <  pos`: the tail-eraser stopped inside the span, so
  //     `[start, pos)` is still resident. When
  //     `remove_thinking_from_context` is enabled we must not silently leave
  //     reasoning tokens in cache, so clamp the effective end to `pos` and let
  //     the compaction paths drop exactly the resident remainder.
  //
  // Recurrent / hybrid path cannot compact the partial-resident
  // sub-case: replay is anchored at `snapshotPos` with a captured
  // post-reasoning tail; if the live cache is shorter than that
  // captured tail, the replay buffer and live cache no longer describe
  // the same suffix. Returning `NoOp` here would complete the request
  // with `[start, pos)` reasoning tokens still resident, violating the strict
  // cleanup contract. The compactor does not own the
  // driver's pre-request rollback anchor, so the only self-contained
  // recovery is to wipe the sequence and force the caller through the
  // existing `FailedKvWiped` hard-fail path.
  if (recordedEnd > pos) {
    if (start >= pos) {
      return out;
    }
    if (needsRecurrentSnapshot_) {
      QLOG_IF(
          Priority::WARNING,
          string_format(
              "%s thinking-block compaction: recurrent path cannot "
              "reconcile clamped span [%d, %d) against captured "
              "post-reasoning tail (recordedEnd=%d, pos=%d, "
              "seqId=%d); wiping sequence and hard-failing so "
              "reasoning does not remain in cache\n",
              labelTag,
              start,
              pos,
              recordedEnd,
              pos,
              seqId));
      clearSeqOnFailure(ctx, seqId);
      out.kind = Outcome::Kind::FailedKvWiped;
      out.failureMessage = string_format(
          "%s ReasoningBlockCompactor::compact: recurrent / hybrid "
          "partial-resident reasoning span [%d, %d) remains after tail "
          "trim (recordedEnd=%d, pos=%d, seqId=%d)",
          labelTag,
          start,
          pos,
          recordedEnd,
          pos,
          seqId);
      return out;
    }
  }
  const llama_pos end = openEnded ? pos : std::min(recordedEnd, pos);

  // Defence-in-depth: `setOpenSpan` refuses a span with no boundary and
  // `snapshotAtPrefillBoundary` anchors one for every model, so
  // `thinkSpan_.has_value()` implies a boundary exists. If a future caller
  // ever seeds a span bypassing those sites, fail hard rather than leave the
  // reasoning span in cache: there is nothing to rewind to.
  if (!rollback_.hasReasoningBoundary()) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s thinking-block compaction failed: recurrent / hybrid "
            "model reached compact() without a boundary snapshot "
            "(start=%d, end=%d, pos=%d, seqId=%d); hard-failing so the "
            "reasoning span does not remain in cache\n",
            labelTag,
            start,
            end,
            pos,
            seqId));
    // Live memory is untouched at this defensive point, but we still
    // report `FailedKvWiped` because the recurrent path's caller
    // recovery is a full reset onto pos=0 — there is no coherent
    // pre-request cursor to unwind to on a recurrent driver. Wipe the
    // sequence so live memory matches that reset.
    clearSeqOnFailure(ctx, seqId);
    out.kind = Outcome::Kind::FailedKvWiped;
    out.failureMessage = string_format(
        "%s ReasoningBlockCompactor::compact: no reasoning "
        "boundary snapshot available on hybrid/recurrent path "
        "(start=%d, end=%d, pos=%d, seqId=%d)",
        labelTag,
        start,
        end,
        pos,
        seqId);
    return out;
  }

  // Recurrent / hybrid path. A `seq_rm` over a partial tail that
  // includes the final committed position is rejected by the
  // recurrent memory module, so we cannot use the pure-attention
  // primitive here. Instead:
  //   1. restore the FULL-state snapshot taken at the recurrent
  //      rollback boundary — this rebuilds both the attention KV and
  //      the recurrent state back to that point in one call; no
  //      `seq_rm` is needed.
  //   2. replay only the post-reasoning tokens through `llama_decode`
  //      starting at `snapshot.nPast`, so the new tokens occupy the
  //      cells immediately after the restored prefix.
  //
  // The kept prefix is `[0, snapshot.nPast)`. For forced-open
  // templates, that includes the opener residue documented by the
  // snapshot-at-end-of-prefill strategy.
  //
  // `pos - end` is the captured post-reasoning tail length (the live
  // cache holds tokens at positions `[end, pos)`). The replay buffer
  // additionally holds a seeded close marker at its head, which
  // `clipPostReasoningTokens` preserves regardless of the cap; passing
  // the captured-tail length here drops any captured tokens that a
  // tail trim has since removed from the live cache,
  // without touching the structural prefix.
  const llama_pos snapshotPos = rollback_.reasoningBoundaryNPast();
  rollback_.clipPostReasoningTokens(static_cast<size_t>(pos - end));

  if (!rewindOps.restoreBoundary(rollback_, ctx, seqId)) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s thinking-block compaction failed: full-state restore "
            "underflowed (start=%d, end=%d, snapshotPos=%d, "
            "seqId=%d)\n",
            labelTag,
            start,
            end,
            snapshotPos,
            seqId));
    // llama.cpp reports the load short-read but does not tell us
    // whether it left the sequence untouched or in a partially loaded
    // state. Either way it is unsafe to keep decoding into it: the
    // recurrent hidden state is not positionally indexed and cannot
    // be reasoned about after an aborted `state_seq_load_file`. Wipe
    // the sequence (attention KV cells + recurrent state) so the
    // caller's post-catch reset onto pos=0 matches live memory, then
    // fail hard so callers cannot save a cache whose header no longer
    // matches what is serialized.
    clearSeqOnFailure(ctx, seqId);
    out.kind = Outcome::Kind::FailedKvWiped;
    out.failureMessage = string_format(
        "%s ReasoningBlockCompactor::compact: full-state restore "
        "underflowed during compaction; sequence "
        "cleared (snapshotPos=%d, spanStart=%d, spanEnd=%d, "
        "seqId=%d)",
        labelTag,
        snapshotPos,
        start,
        end,
        seqId);
    return out;
  }

  const size_t replayCount = rollback_.postReasoningTokenCount();
  if (!rewindOps.replayPostReasoning(rollback_, ctx, seqId)) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s thinking-block compaction failed: post-reasoning "
            "replay rejected (snapshotPos=%d, replayCount=%zu, "
            "seqId=%d)\n",
            labelTag,
            snapshotPos,
            replayCount,
            seqId));
    // Restore succeeded, so live memory currently sits at
    // `snapshotPos`, but the replay decoded an unknown prefix of the
    // post-reasoning tokens before failing — the recurrent state has
    // partially advanced past `snapshotPos` with no way to observe
    // how far. Same coherence problem as restore failure; same fix.
    clearSeqOnFailure(ctx, seqId);
    out.kind = Outcome::Kind::FailedKvWiped;
    out.failureMessage = string_format(
        "%s ReasoningBlockCompactor::compact: post-reasoning "
        "replay rejected during compaction; sequence "
        "cleared (snapshotPos=%d, replayCount=%zu, seqId=%d)",
        labelTag,
        snapshotPos,
        replayCount,
        seqId);
    return out;
  }

  const llama_pos newPos = snapshotPos + static_cast<llama_pos>(replayCount);
  out.kind = Outcome::Kind::Compacted;
  out.newPos = newPos;
  out.discarded = pos - newPos;
  out.replayedTokens = replayCount;
  ++thinkingBlockDiscards_;
  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "%s thinking-block compaction (recurrent): dropped %d tokens "
          "(span [%d, %d), kept [0, %d)), replayed %zu post-reasoning "
          "tokens, newPos=%d\n",
          labelTag,
          out.discarded,
          start,
          end,
          snapshotPos,
          replayCount,
          newPos));
  return out;
}

} // namespace qvac_lib_inference_addon_llama

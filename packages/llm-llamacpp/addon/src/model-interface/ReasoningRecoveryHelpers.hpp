#pragma once

#include <functional>

#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "../addon/LlmErrors.hpp"
#include "../utils/ReasoningRollbackState.hpp"
#include "../utils/ReasoningSnapshotPolicy.hpp"
#include "ReasoningBlockCompactor.hpp"
#include "common/common.h"
#include "utils/LoggingMacros.hpp"

// Shared recovery policy for TextLlmContext and MtmdLlmContext. The contexts
// still own their local positional bookkeeping; these helpers centralise the
// branch decisions that must stay identical across text and multimodal drivers.

namespace qvac_lib_inference_addon_llama::reasoning_recovery {

[[noreturn]] inline void throwUnsupportedReasoningCompaction(
    const char* labelTag,
    qvac_lib_inference_addon_llama::utils::ReasoningBoundaryDecision decision) {
  throw qvac_errors::StatusError(
      qvac_lib_inference_addon_llama::errors::ADDON_ID,
      qvac_lib_inference_addon_llama::errors::toString(
          qvac_lib_inference_addon_llama::errors::FailedToDecode),
      string_format(
          "%s remove_thinking_from_context is enabled, but reasoning "
          "compaction requires a single-token "
          "reasoning close marker; unsupported because %s",
          labelTag,
          qvac_lib_inference_addon_llama::utils::reasoningBoundaryFailureReason(
              decision)));
}

inline void clearMemoryForRecovery(::llama_context* ctx, llama_seq_id seqId) {
  auto* mem = llama_get_memory(ctx);
  if (mem != nullptr) {
    (void)seqId;
    llama_memory_clear(mem, true);
  }
}

struct PrefillEntryRecoveryHooks {
  ::llama_context* ctx = nullptr;
  llama_seq_id seqId = 0;
  qvac_lib_inference_addon_llama::utils::ReasoningRollbackState& rollback;
  std::function<void(llama_pos restoredNPast)> onRestored;
  std::function<void()> onCleared;
};

inline bool
restorePrefillEntryOrClearSequence(const PrefillEntryRecoveryHooks& hooks) {
  if (hooks.rollback.hasPrefillEntry()) {
    const llama_pos restoredNPast = hooks.rollback.prefillEntryNPast();
    if (hooks.rollback.restorePrefillEntry(hooks.ctx, hooks.seqId)) {
      hooks.onRestored(restoredNPast);
      return true;
    }
  }

  clearMemoryForRecovery(hooks.ctx, hooks.seqId);
  hooks.onCleared();
  return false;
}

struct CancelRecoveryHooks {
  const char* labelTag = "";
  ::llama_context* ctx = nullptr;
  llama_seq_id seqId = 0;
  bool reasoningRemovalEnabled = false;
  llama_pos currentPos = 0;
  llama_pos preRequestPos = 0;
  qvac_lib_inference_addon_llama::utils::ReasoningRollbackState& rollback;
  std::function<void(llama_pos restoredNPast)> onSnapshotRestored;
  std::function<void(llama_pos restoredNPast)> onSnapshotRestoreFailed;
  std::function<void()> onMissingSnapshotAdvanced;
  std::function<void(llama_pos delta)> removeLastNTokens;
  std::function<void()> onTokensRolledBack;
};

inline bool rollbackCancelledRequest(const CancelRecoveryHooks& hooks) {
  bool rollbackOk = true;

  if (hooks.rollback.hasPrefillEntry()) {
    const llama_pos restoredNPast = hooks.rollback.prefillEntryNPast();
    if (hooks.rollback.restorePrefillEntry(hooks.ctx, hooks.seqId)) {
      hooks.onSnapshotRestored(restoredNPast);
    } else {
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          string_format(
              "%s prefillEntry restore failed on cancel "
              "(snapshotNPast=%d, currentNPast=%d, seqId=%d); scheduler "
              "must skip saveCache to preserve last known-good on-disk "
              "cache\n",
              hooks.labelTag,
              restoredNPast,
              hooks.currentPos,
              hooks.seqId));
      hooks.onSnapshotRestoreFailed(restoredNPast);
      rollbackOk = false;
    }
  } else if (
      hooks.reasoningRemovalEnabled && hooks.currentPos > hooks.preRequestPos) {
    QLOG_IF(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        string_format(
            "%s cancel with reasoning removal enabled but no prefill-entry "
            "snapshot and advanced cursor (preRequestNPast=%d, "
            "currentNPast=%d, seqId=%d); scheduler must skip saveCache\n",
            hooks.labelTag,
            hooks.preRequestPos,
            hooks.currentPos,
            hooks.seqId));
    hooks.onMissingSnapshotAdvanced();
    rollbackOk = false;
  } else {
    const llama_pos delta = hooks.currentPos - hooks.preRequestPos;
    if (delta > 0) {
      hooks.removeLastNTokens(delta);
      hooks.onTokensRolledBack();
    }
  }

  return rollbackOk;
}

struct CompactionOutcomeHooks {
  std::function<void(
      const qvac_lib_inference_addon_llama::ReasoningBlockCompactor::Outcome&)>
      onCompacted;
  std::function<void()> onFailedKvIntact;
  std::function<void()> onFailedKvWiped;
};

inline void handleCompactionOutcome(
    const qvac_lib_inference_addon_llama::ReasoningBlockCompactor::Outcome&
        outcome,
    const CompactionOutcomeHooks& hooks) {
  using OutcomeKind =
      qvac_lib_inference_addon_llama::ReasoningBlockCompactor::Outcome::Kind;
  switch (outcome.kind) {
  case OutcomeKind::CompactedAttention:
  case OutcomeKind::CompactedRecurrent:
    hooks.onCompacted(outcome);
    return;
  case OutcomeKind::NoOp:
    return;
  case OutcomeKind::FailedKvIntact:
    hooks.onFailedKvIntact();
    throw qvac_errors::StatusError(
        qvac_lib_inference_addon_llama::errors::ADDON_ID,
        qvac_lib_inference_addon_llama::errors::toString(
            qvac_lib_inference_addon_llama::errors::FailedToDecode),
        outcome.failureMessage);
  case OutcomeKind::FailedKvWiped:
    hooks.onFailedKvWiped();
    throw qvac_errors::StatusError(
        qvac_lib_inference_addon_llama::errors::ADDON_ID,
        qvac_lib_inference_addon_llama::errors::toString(
            qvac_lib_inference_addon_llama::errors::FailedToDecode),
        outcome.failureMessage);
  }
}

} // namespace qvac_lib_inference_addon_llama::reasoning_recovery

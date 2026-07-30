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

[[noreturn]] inline void throwUnsupportedRecurrentReasoningCompaction(
    const char* labelTag,
    qvac_lib_inference_addon_llama::utils::RecurrentReasoningBoundaryDecision
        decision) {
  throw qvac_errors::StatusError(
      qvac_lib_inference_addon_llama::errors::ADDON_ID,
      qvac_lib_inference_addon_llama::errors::toString(
          qvac_lib_inference_addon_llama::errors::FailedToDecode),
      string_format(
          "%s remove_thinking_from_context is enabled for a hybrid/recurrent "
          "model, but recurrent reasoning compaction requires a single-token "
          "reasoning close marker; unsupported because %s",
          labelTag,
          qvac_lib_inference_addon_llama::utils::
              recurrentReasoningBoundaryFailureReason(decision)));
}

inline void clearSeqForRecovery(::llama_context* ctx, llama_seq_id seqId) {
  auto* mem = llama_get_memory(ctx);
  if (mem != nullptr) {
    (void)llama_memory_seq_rm(mem, seqId, -1, -1);
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

  clearSeqForRecovery(hooks.ctx, hooks.seqId);
  hooks.onCleared();
  return false;
}

struct CancelRecoveryHooks {
  const char* labelTag = "";
  ::llama_context* ctx = nullptr;
  llama_seq_id seqId = 0;
  bool needsRecurrentSnapshot = false;
  llama_pos currentPos = 0;
  llama_pos preRequestPos = 0;
  qvac_lib_inference_addon_llama::utils::ReasoningRollbackState& rollback;
  std::function<void(llama_pos restoredNPast)> onRecurrentRestored;
  std::function<void(llama_pos restoredNPast)> onRecurrentRestoreFailed;
  std::function<void()> onRecurrentMissingSnapshotAdvanced;
  std::function<void(llama_pos delta)> removeLastNTokens;
  std::function<void()> onPureAttentionRolledBack;
};

inline bool rollbackCancelledRequest(const CancelRecoveryHooks& hooks) {
  bool rollbackOk = true;

  if (hooks.needsRecurrentSnapshot) {
    if (hooks.rollback.hasPrefillEntry()) {
      const llama_pos restoredNPast = hooks.rollback.prefillEntryNPast();
      if (hooks.rollback.restorePrefillEntry(hooks.ctx, hooks.seqId)) {
        hooks.onRecurrentRestored(restoredNPast);
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
        hooks.onRecurrentRestoreFailed(restoredNPast);
        rollbackOk = false;
      }
    } else if (hooks.currentPos > hooks.preRequestPos) {
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          string_format(
              "%s cancel with no prefill-entry snapshot and advanced cursor "
              "(preRequestNPast=%d, currentNPast=%d, seqId=%d); scheduler must "
              "skip saveCache to avoid persisting the cancelled request's "
              "peak state\n",
              hooks.labelTag,
              hooks.preRequestPos,
              hooks.currentPos,
              hooks.seqId));
      hooks.onRecurrentMissingSnapshotAdvanced();
      rollbackOk = false;
    }
  } else {
    const llama_pos delta = hooks.currentPos - hooks.preRequestPos;
    if (delta > 0) {
      hooks.removeLastNTokens(delta);
      hooks.onPureAttentionRolledBack();
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

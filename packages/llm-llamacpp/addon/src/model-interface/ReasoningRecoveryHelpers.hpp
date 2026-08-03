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
  llama_pos currentPos = 0;
  llama_pos preRequestPos = 0;
  qvac_lib_inference_addon_llama::utils::ReasoningRollbackState& rollback;
  std::function<void(llama_pos restoredNPast)> onSnapshotRestored;
  std::function<void()> onCheckpointFailure;
};

inline bool rollbackCancelledRequest(const CancelRecoveryHooks& hooks) {
  if (hooks.rollback.hasPrefillEntry()) {
    const llama_pos restoredNPast = hooks.rollback.prefillEntryNPast();
    if (hooks.rollback.restorePrefillEntry(hooks.ctx, hooks.seqId)) {
      hooks.onSnapshotRestored(restoredNPast);
      return true;
    }
  }

  QLOG_IF(
      qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
      string_format(
          "%s mandatory cancellation checkpoint restore failed or checkpoint "
          "is missing (preRequestNPast=%d, currentNPast=%d, seqId=%d); "
          "clearing memory and skipping cache save\n",
          hooks.labelTag,
          hooks.preRequestPos,
          hooks.currentPos,
          hooks.seqId));
  clearMemoryForRecovery(hooks.ctx, hooks.seqId);
  hooks.onCheckpointFailure();
  return false;
}

struct CompactionOutcomeHooks {
  std::function<void(
      const qvac_lib_inference_addon_llama::ReasoningBlockCompactor::Outcome&)>
      onCompacted;
  std::function<void()> onFailedKvWiped;
};

inline void handleCompactionOutcome(
    const qvac_lib_inference_addon_llama::ReasoningBlockCompactor::Outcome&
        outcome,
    const CompactionOutcomeHooks& hooks) {
  using OutcomeKind =
      qvac_lib_inference_addon_llama::ReasoningBlockCompactor::Outcome::Kind;
  switch (outcome.kind) {
  case OutcomeKind::CompactedRecurrent:
    hooks.onCompacted(outcome);
    return;
  case OutcomeKind::NoOp:
    return;
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

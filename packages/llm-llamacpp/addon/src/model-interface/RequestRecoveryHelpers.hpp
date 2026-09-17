#pragma once

#include <functional>

#include <llama.h>

#include "../utils/RequestRollbackState.hpp"
#include "common/common.h"
#include "utils/LoggingMacros.hpp"

namespace qvac_lib_inference_addon_llama::request_recovery {

struct CancelRecoveryHooks {
  const char* labelTag = "";
  ::llama_context* ctx = nullptr;
  llama_seq_id seqId = 0;
  bool needsRecurrentSnapshot = false;
  llama_pos currentPos = 0;
  llama_pos preRequestPos = 0;
  qvac_lib_inference_addon_llama::utils::RequestRollbackState& rollback;
  std::function<void(llama_pos restoredNPast)> onRecurrentRestored;
  std::function<void(llama_pos restoredNPast)> onRecurrentRestoreFailed;
  std::function<void()> onRecurrentMissingSnapshotAdvanced;
  std::function<void(llama_pos delta)> removeLastNTokens;
  std::function<void()> onPureAttentionRolledBack;
};

inline bool rollbackCancelledRequest(const CancelRecoveryHooks& hooks) {
  bool rollbackOk = true;

  if (hooks.needsRecurrentSnapshot) {
    if (hooks.rollback.hasSnapshot()) {
      const llama_pos restoredNPast = hooks.rollback.nPast();
      if (hooks.rollback.restore(hooks.ctx, hooks.seqId)) {
        hooks.onRecurrentRestored(restoredNPast);
      } else {
        QLOG_IF(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            string_format(
                "%s request snapshot restore failed on cancel "
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
              "%s cancel with no request snapshot and advanced cursor "
              "(preRequestNPast=%d, currentNPast=%d, seqId=%d); scheduler "
              "must skip saveCache to avoid persisting the cancelled "
              "request's peak state\n",
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

} // namespace qvac_lib_inference_addon_llama::request_recovery

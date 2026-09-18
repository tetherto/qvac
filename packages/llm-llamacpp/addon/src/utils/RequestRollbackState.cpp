#include "RequestRollbackState.hpp"

namespace qvac_lib_inference_addon_llama::utils {

bool RequestRollbackState::capture(
    ::llama_context* ctx, llama_seq_id seqId, llama_pos nPast) {
  snapshot_.clear();
  return snapshotRecurrentState(ctx, seqId, nPast, snapshot_);
}

bool RequestRollbackState::restore(::llama_context* ctx, llama_seq_id seqId) {
  if (snapshot_.empty()) {
    return false;
  }
  return restoreRecurrentState(ctx, seqId, snapshot_);
}

void RequestRollbackState::seedForTesting(llama_pos nPast) noexcept {
  snapshot_.seedForTesting("qvac_test_request_rollback_sentinel.bin", nPast);
}

} // namespace qvac_lib_inference_addon_llama::utils

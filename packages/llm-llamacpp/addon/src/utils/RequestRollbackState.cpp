#include "RequestRollbackState.hpp"

namespace qvac_lib_inference_addon_llama::utils {

bool RequestRollbackState::capture(
    ::llama_context* ctx, llama_seq_id seqId, llama_pos nPast) {
  snapshot_.clear();
  return snapshotSequenceState(ctx, seqId, nPast, snapshot_, storage_);
}

bool RequestRollbackState::restore(::llama_context* ctx, llama_seq_id seqId) {
  if (snapshot_.empty()) {
    return false;
  }
  return restoreSequenceState(ctx, seqId, snapshot_);
}

} // namespace qvac_lib_inference_addon_llama::utils

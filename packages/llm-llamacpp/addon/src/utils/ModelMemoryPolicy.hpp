#pragma once

#include "SequenceStateSnapshot.hpp"

namespace qvac_lib_inference_addon_llama::utils {

// Full-state snapshots are required by recurrent and hybrid models, and by
// DeepSeek V4 whose compressed cache has the same checkpoint/restore
// requirement despite not reporting either model predicate.
[[nodiscard]] inline bool needsFullStateSnapshot(
    bool isRecurrent, bool isHybrid, bool isDeepSeekV4) noexcept {
  return isRecurrent || isHybrid || isDeepSeekV4;
}

// Which part of the sequence those snapshots hold. Hybrid and recurrent
// memory only need their recurrent state saved: the attention KV is trimmed
// back instead, which keeps a snapshot the size of that state however long
// the context grows. DeepSeek V4 keeps full snapshots: its partial state
// (fabric `llama_kv_cache_dsv4::state_write`) omits the compressed K caches,
// and its `seq_rm` refuses a tail trim below the end of the sequence (only a
// bounded speculative rollback of `n_rs_seq` tokens, 0 by default), so a
// partial restore could neither drop the later raw cells nor the compressed
// rows past the checkpoint.
[[nodiscard]] inline SnapshotScope
snapshotScopeFor(bool isDeepSeekV4) noexcept {
  return isDeepSeekV4 ? SnapshotScope::Full : SnapshotScope::Partial;
}

} // namespace qvac_lib_inference_addon_llama::utils

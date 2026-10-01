#pragma once

#include <cstddef>

#include "SequenceStateSnapshot.hpp"

namespace qvac_lib_inference_addon_llama::utils {

// Models whose memory cannot drop a tail at an arbitrary position need
// snapshots for rollback and process-local checkpoints: recurrent and hybrid
// models, and DeepSeek V4, whose compressed cache has the same restriction
// without reporting either model predicate. Decided by architecture.
[[nodiscard]] inline bool needsFullStateSnapshot(
    bool isRecurrent, bool isHybrid, bool isDeepSeekV4) noexcept {
  return isRecurrent || isHybrid || isDeepSeekV4;
}

// Which part of the sequence those snapshots hold: only what a tail trim
// cannot rebuild (`LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY`); a restore puts it
// back and trims the rest to the snapshot's position. That holds for every
// model above, so a snapshot's size is fixed by the model, not the context:
//   * recurrent: the recurrent state, which is all the memory holds;
//   * hybrid: the recurrent state; the attention KV is trimmed;
//   * DeepSeek V4 (fabric `llama_kv_cache_dsv4`): the sliding-window raw
//     cells and the compressor states. After the restore the window reports
//     the snapshot's position as the end of the sequence, so the trim takes
//     the "past the end" branch of `seq_rm`, which drops the raw cells and
//     the compressed rows past it. Compressed rows are only written once a
//     whole block is complete; an unfinished block lives in the compressor
//     state, which the snapshot holds, so no row is lost. Fabric's own
//     llama-server restores DeepSeek V4 the same way.
[[nodiscard]] inline SnapshotScope untrimmableSnapshotScope() noexcept {
  return SnapshotScope::Partial;
}

// `cache_checkpoints` when the load config does not set it. A committed
// cached request pushes its pre-request snapshot and then its end-of-history
// checkpoint. Recurrent and hybrid models keep that pair (2): the
// end-of-history one serves an ordinary next turn and a regenerate, the
// pre-request one an edit of the last message. Other untrimmable models
// (DeepSeek V4) keep only the newest, the end-of-history one (1).
[[nodiscard]] inline size_t
defaultCacheCheckpoints(bool isRecurrent, bool isHybrid) noexcept {
  return isRecurrent || isHybrid ? 2 : 1;
}

} // namespace qvac_lib_inference_addon_llama::utils

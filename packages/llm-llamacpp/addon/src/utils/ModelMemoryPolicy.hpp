#pragma once

#include <cstddef>
#include <cstdint>

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

// Sliding-window models (without `swa_full`) trim a KV tail only while the
// window in front of the trim point is resident, so they also take
// end-of-history checkpoints, holding the window cells. Rollback stays a trim.
[[nodiscard]] inline bool
takesSlidingWindowCheckpoints(int32_t nSwa, bool swaFull) noexcept {
  return nSwa > 0 && !swaFull;
}

// Upper bound on the cells one sequence holds in a sliding-window cache, as
// fabric's `llama_kv_cache_iswa` sizes it: the window per sequence (all of
// them when unified) plus one ubatch, padded to 256 cells. A sliding-window
// checkpoint holds at most this many.
[[nodiscard]] inline uint32_t slidingWindowCacheCells(
    int32_t nSwa, uint32_t nSeqMax, uint32_t nUbatch, bool unified) noexcept {
  if (nSwa <= 0) {
    return 0;
  }
  const uint64_t cells =
      static_cast<uint64_t>(nSwa) * (unified ? nSeqMax : 1U) + nUbatch;
  const uint64_t padded = (cells + 255U) / 256U * 256U;
  return padded > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(padded);
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
//     the "past the end" branch of `seq_rm`, which drops the raw cells past
//     it. The compressed rows are not part of the snapshot and the trim does
//     not clear them: a row sits at `pos / ratio`, a query sees only the rows
//     its own position has completed, and the token that completes a block
//     rewrites its row, so rows from before the snapshot are reused and the
//     rows past it are overwritten before anything reads them. The
//     unfinished block at the snapshot lives in the compressor state, which
//     the snapshot holds. Fabric's own llama-server restores DeepSeek V4 the
//     same way.
//   * sliding window (fabric `llama_kv_cache_iswa`): the window cells; the
//     full-attention cells are trimmed.
[[nodiscard]] inline SnapshotScope untrimmableSnapshotScope() noexcept {
  return SnapshotScope::Partial;
}

} // namespace qvac_lib_inference_addon_llama::utils

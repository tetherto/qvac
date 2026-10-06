#pragma once

#include <cstdint>
#include <vector>

#include "common/common.h"
#include "common/sampling.h"
#include "llama.h"

namespace qvac_lib_inference_addon_llama::speculative {

class SpeculativeRuntime;

/// Speculative-decoding counters of one generation, as llama-server reports
/// them in its timings (`draft_n`, `draft_n_accepted`) and its
/// "draft acceptance" log line.
struct SpeculativeStats {
  /// Draft tokens proposed by the draft context.
  uint64_t draftTokens = 0;
  /// Draft tokens the target model accepted.
  uint64_t draftAccepted = 0;
  /// Verification steps (target decodes that checked a draft).
  uint64_t verifySteps = 0;
  /// Accepted drafts per draft position, for the per-position rates.
  std::vector<uint64_t> acceptedPerPos;

  void reset() { *this = SpeculativeStats{}; }
  void add(const SpeculativeStats& other);
};

/// The speculative part of one sequence's generation loop: a port of
/// llama-server's per-slot `spec_draft` / `spec_i_batch` / `spec_ckpt` /
/// `spec_is_replay` state and of the draft, checkpoint, verify and rollback
/// steps of `update_slots` and `post_decode`.
///
/// One generation step, with `nTokens` tokens resident in the target
/// sequence and `sampled` the last sampled token, not decoded yet:
///   1. `prepareDraft` (skipped while a replay draft is pending)
///   2. `common_speculative_draft` once for every prepared sequence
///      (`draftPrepared`)
///   3. `afterDraft`: draft-context rewind, target checkpoint when the draft
///      cannot be rolled back by trimming
///   4. `addToBatch`: `sampled` and the draft at consecutive positions, every
///      one with logits
///   5. target decode, `SpeculativeRuntime::process`
///   6. `verify`: accept the longest matching draft prefix plus one new token
///      and rewind both contexts past it, or restore the checkpoint and
///      replay
class SpeculativeSequence {
public:
  /// Result of `verify`.
  struct Verified {
    /// True when partial acceptance had to restore the checkpoint: nothing
    /// was accepted yet, the target sequence is back at `keepTokens` tokens
    /// and the next step re-decodes `sampled` plus the accepted tokens.
    bool replay = false;
    /// Tokens the target sequence holds after the step: the tokens before
    /// it, `sampled`, and every accepted token except the last.
    llama_pos keepTokens = 0;
    /// Accepted tokens followed by the target's own next token; the last
    /// one becomes the new `sampled`. Empty on replay.
    std::vector<llama_token> ids;
  };

  SpeculativeSequence() = default;

  void bind(const SpeculativeRuntime* runtime, llama_seq_id seqId);
  [[nodiscard]] bool enabled() const { return runtime_ != nullptr; }
  [[nodiscard]] const SpeculativeRuntime* runtime() const { return runtime_; }

  /// Drops the per-generation state (`server_slot::reset`).
  void reset();

  /// Starts a generation once its prompt is decoded
  /// (`common_speculative_begin`).
  void begin(const std::vector<llama_token>& prompt) const;

  /// llama-server's `get_n_draft_max`: the longest draft that fits the
  /// sequence window (`nCtx`, leaving room for the sampled token and one
  /// more) and the remaining prediction budget (`nRemaining`, -1 when
  /// unlimited).
  [[nodiscard]] static int
  maxDraft(int32_t nCtx, llama_pos nTokens, int32_t nRemaining);

  /// Step 1. Returns true when this sequence asked for a new draft; false
  /// when it keeps a pending replay draft or `nDraftMax <= 0`.
  bool prepareDraft(
      int nDraftMax, llama_pos nTokens, llama_token sampled,
      const std::vector<llama_token>& prompt);

  /// Step 2, once for all sequences of the runtime.
  static void draftPrepared(const SpeculativeRuntime& runtime);

  /// Step 3, for a sequence `prepareDraft` returned true for.
  void afterDraft();

  [[nodiscard]] bool hasDraft() const { return !draft_.empty(); }
  [[nodiscard]] const std::vector<llama_token>& draft() const {
    return draft_;
  }

  /// Step 4. Appends `sampled` at `pos` and the draft after it, recording
  /// their batch indices for `verify`.
  void addToBatch(llama_batch& batch, llama_token sampled, llama_pos pos);

  /// Step 4 when someone else fills the batch: `sampled` sits at batch index
  /// `first` and the draft right after it.
  void setBatchStart(int32_t first);

  /// Drops a draft that never reached the target (no room in the batch).
  /// The sampler and both contexts are still at the pre-draft state.
  void discardDraft();

  /// Step 6. `nTokens` is the resident token count before step 4. Samples
  /// with `smpl` (accepting the tokens into it) and rewinds the target and
  /// draft sequences.
  [[nodiscard]] Verified verify(common_sampler* smpl, llama_pos nTokens);

  [[nodiscard]] const SpeculativeStats& stats() const { return stats_; }
  void resetStats() { stats_.reset(); }

private:
  [[nodiscard]] bool useTargetCheckpoint(size_t nRollback) const;

  const SpeculativeRuntime* runtime_ = nullptr;
  llama_seq_id seqId_ = 0;

  std::vector<llama_token> draft_;
  std::vector<llama_token> prompt_;
  std::vector<int32_t> iBatch_;
  common_prompt_checkpoint ckpt_{};
  bool isReplay_ = false;
  SpeculativeStats stats_;
};

} // namespace qvac_lib_inference_addon_llama::speculative

#include "SpeculativeSequence.hpp"

#include <algorithm>
#include <string>

#include <inference-addon-cpp/Errors.hpp>

#include "SpeculativeRuntime.hpp"
#include "addon/LlmErrors.hpp"

using namespace qvac_lib_inference_addon_llama::errors;

namespace qvac_lib_inference_addon_llama::speculative {

namespace {

void seqRmOrThrow(llama_context* ctx, llama_seq_id seqId, llama_pos p0) {
  if (ctx == nullptr) {
    return;
  }
  if (!llama_memory_seq_rm(llama_get_memory(ctx), seqId, p0, -1)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(FailedToDecode),
        "[Speculative] failed to remove the rejected draft from sequence " +
            std::to_string(seqId));
  }
}

} // namespace

void SpeculativeStats::add(const SpeculativeStats& other) {
  draftTokens += other.draftTokens;
  draftAccepted += other.draftAccepted;
  verifySteps += other.verifySteps;
  if (acceptedPerPos.size() < other.acceptedPerPos.size()) {
    acceptedPerPos.resize(other.acceptedPerPos.size(), 0);
  }
  for (size_t i = 0; i < other.acceptedPerPos.size(); ++i) {
    acceptedPerPos[i] += other.acceptedPerPos[i];
  }
}

void SpeculativeSequence::bind(
    const SpeculativeRuntime* runtime, llama_seq_id seqId) {
  runtime_ = runtime;
  seqId_ = seqId;
  reset();
}

void SpeculativeSequence::reset() {
  isReplay_ = false;
  draft_.clear();
  iBatch_.clear();
  ckpt_.clear();
}

void SpeculativeSequence::setPromptEnd(llama_pos posEnd) const {
  if (runtime_ != nullptr) {
    common_speculative_set_prompt_end(runtime_->spec(), seqId_, posEnd);
  }
}

void SpeculativeSequence::begin(const std::vector<llama_token>& prompt) const {
  if (runtime_ != nullptr) {
    common_speculative_begin(runtime_->spec(), seqId_, prompt);
  }
}

int SpeculativeSequence::maxDraft(
    int32_t nCtx, llama_pos nTokens, int32_t nRemaining) {
  // The prompt is not yet extended with the sampled token, and one more
  // position stays free for a context shift.
  int nDraftMax = nCtx - nTokens - 2;
  if (nRemaining > 0) {
    nDraftMax = std::min(nDraftMax, nRemaining - 1);
  }
  return nDraftMax;
}

bool SpeculativeSequence::prepareDraft(
    int nDraftMax, llama_pos nTokens, llama_token sampled,
    const std::vector<llama_token>& prompt) {
  if (runtime_ == nullptr) {
    return false;
  }
  common_speculative_get_draft_params(runtime_->spec(), seqId_).drafting =
      false;
  if (nDraftMax <= 0) {
    return false;
  }
  if (!draft_.empty()) {
    // A previous (partial) draft is replayed: it is decoded again from the
    // restored checkpoint without asking for a new one.
    return false;
  }

  llama_context* ctxTgt = runtime_->ctxTgt();
  llama_context* ctxDft = runtime_->ctxDft();
  ckpt_.update_pos(
      nTokens,
      llama_memory_seq_pos_min(llama_get_memory(ctxTgt), seqId_),
      llama_memory_seq_pos_max(llama_get_memory(ctxTgt), seqId_));
  if (runtime_->dftSeqRmType() == COMMON_CONTEXT_SEQ_RM_TYPE_FULL) {
    ckpt_.update_dft(ctxDft, seqId_, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
  }

  prompt_ = prompt;
  common_speculative_get_draft_params(runtime_->spec(), seqId_) = {
      /* .drafting = */ true,
      /* .n_max    = */ nDraftMax,
      /* .pos0     = */ nTokens,
      /* .id_last  = */ sampled,
      /* .prompt   = */ &prompt_,
      /* .result   = */ &draft_,
  };
  return true;
}

void SpeculativeSequence::draftPrepared(const SpeculativeRuntime& runtime) {
  common_speculative_draft(runtime.spec());
}

void SpeculativeSequence::afterDraft() {
  stats_.draftTokens += draft_.size();

  llama_context* ctxTgt = runtime_->ctxTgt();
  llama_context* ctxDft = runtime_->ctxDft();
  // Drafting decoded the draft into the draft context; rewind it to the
  // verified prefix, the verification batch will add the tokens again.
  if (ctxDft != nullptr) {
    if (runtime_->dftSeqRmType() == COMMON_CONTEXT_SEQ_RM_TYPE_FULL) {
      ckpt_.load_dft(ctxDft, seqId_, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
    }
    seqRmOrThrow(ctxDft, seqId_, ckpt_.pos_max + 1);
  }

  if (draft_.empty()) {
    return;
  }
  // Partial acceptance must be undone by a checkpoint when the target memory
  // cannot drop the rejected tail by itself.
  if (useTargetCheckpoint(draft_.size())) {
    ckpt_.update_tgt(ctxTgt, seqId_, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
  }
  if (runtime_->dftSeqRmType() == COMMON_CONTEXT_SEQ_RM_TYPE_RS &&
      draft_.size() > llama_n_rs_seq(ctxDft)) {
    ckpt_.update_dft(ctxDft, seqId_, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
  }
}

void SpeculativeSequence::addToBatch(
    llama_batch& batch, llama_token sampled, llama_pos pos) {
  iBatch_.clear();
  iBatch_.push_back(batch.n_tokens);
  common_batch_add(batch, sampled, pos, {seqId_}, true);
  for (size_t i = 0; i < draft_.size(); ++i) {
    iBatch_.push_back(batch.n_tokens);
    common_batch_add(
        batch, draft_[i], pos + 1 + static_cast<llama_pos>(i), {seqId_}, true);
  }
}

void SpeculativeSequence::setBatchStart(int32_t first) {
  iBatch_.clear();
  for (int32_t i = 0; i <= static_cast<int32_t>(draft_.size()); ++i) {
    iBatch_.push_back(first + i);
  }
}

void SpeculativeSequence::discardDraft() {
  draft_.clear();
  iBatch_.clear();
  isReplay_ = false;
}

bool SpeculativeSequence::useTargetCheckpoint(size_t nRollback) const {
  const auto type = runtime_->tgtSeqRmType();
  return type == COMMON_CONTEXT_SEQ_RM_TYPE_FULL ||
         (type == COMMON_CONTEXT_SEQ_RM_TYPE_RS &&
          nRollback > llama_n_rs_seq(runtime_->ctxTgt()));
}

SpeculativeSequence::Verified
SpeculativeSequence::verify(common_sampler* smpl, llama_pos nTokens) {
  Verified result;
  llama_context* ctxTgt = runtime_->ctxTgt();
  llama_context* ctxDft = runtime_->ctxDft();

  {
    common_sampler_ptr smplSave(common_sampler_clone(smpl));

    std::vector<int> idxs(iBatch_.begin(), iBatch_.end());
    auto accepted =
        common_sampler_sample_and_accept_n(smpl, ctxTgt, idxs, draft_);
    iBatch_.clear();

    const size_t nRollback = draft_.size() + 1 - accepted.size();
    if (nRollback > 0 && useTargetCheckpoint(nRollback)) {
      // Partial acceptance the context cannot trim: restore the checkpoint
      // taken before the draft and decode the accepted tokens again.
      isReplay_ = true;
      draft_ = std::move(accepted);
      ckpt_.load_tgt(ctxTgt, seqId_, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
      if (ctxDft != nullptr) {
        ckpt_.load_dft(ctxDft, seqId_, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
      }
      seqRmOrThrow(ctxTgt, seqId_, ckpt_.pos_max + 1);
      seqRmOrThrow(ctxDft, seqId_, ckpt_.pos_max + 1);
      common_sampler_copy(smplSave.get(), smpl);
      result.replay = true;
      result.keepTokens = static_cast<llama_pos>(ckpt_.n_tokens);
      return result;
    }

    common_speculative_accept(
        runtime_->spec(), seqId_, static_cast<uint16_t>(accepted.size() - 1));
    result.ids = std::move(accepted);
    draft_.clear();
  }

  size_t nAccepted = result.ids.size() - 1;
  if (isReplay_ && nAccepted > 0) {
    nAccepted--;
  }
  isReplay_ = false;

  stats_.draftAccepted += nAccepted;
  stats_.verifySteps += 1;
  if (stats_.acceptedPerPos.empty()) {
    stats_.acceptedPerPos.resize(
        static_cast<size_t>(std::max(0, runtime_->nDraftMax())), 0);
  }
  for (size_t i = 0; i < nAccepted && i < stats_.acceptedPerPos.size(); ++i) {
    stats_.acceptedPerPos[i]++;
  }

  // The sequence now holds the sampled token and every accepted token but
  // the last; drop the rejected tail from both contexts.
  result.keepTokens = nTokens + static_cast<llama_pos>(result.ids.size());
  seqRmOrThrow(ctxTgt, seqId_, result.keepTokens);
  seqRmOrThrow(ctxDft, seqId_, result.keepTokens);
  return result;
}

} // namespace qvac_lib_inference_addon_llama::speculative

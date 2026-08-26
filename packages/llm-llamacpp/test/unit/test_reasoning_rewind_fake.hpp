#pragma once

// Configurable `IReasoningRewindOps` fake, so compactor tests can drive
// `compact()` without a real llama context. Replaces the `IKvCacheOps` fakes
// that existed while compaction still shifted the cache.
//
// Defaults succeed, which is the successful-drop case. `failRestore()` and
// `failReplay()` drive the two halves of the failure contract. Both failures
// leave the sequence in a state the caller can't reason about, so the
// compactor is expected to wipe and report `FailedKvWiped` either way.
//
// Call counts let a test pin ordering: a failed restore must not be followed
// by a replay, otherwise the reported outcome would understate the damage.

#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ReasoningBlockCompactor.hpp"

namespace qvac_test {

class FakeReasoningRewindOps final
    : public qvac_lib_inference_addon_llama::IReasoningRewindOps {
public:
  using RollbackState =
      qvac_lib_inference_addon_llama::utils::ReasoningRollbackState;

  bool restoreBoundary(
      RollbackState&, ::llama_context*, llama_seq_id) const override {
    ++restoreCalls_;
    return !failRestore_;
  }

  bool replayPostReasoning(
      RollbackState& rollback, ::llama_context*, llama_seq_id) const override {
    ++replayCalls_;
    // `compact()` clears the replay buffer through its RAII guard before
    // returning, so a test can only see the replayed sequence from here.
    replayed_.assign(
        rollback.postReasoningTokens().begin(),
        rollback.postReasoningTokens().end());
    return !failReplay_;
  }

  FakeReasoningRewindOps& failRestore() {
    failRestore_ = true;
    return *this;
  }
  FakeReasoningRewindOps& failReplay() {
    failReplay_ = true;
    return *this;
  }

  int restoreCalls() const { return restoreCalls_; }
  int replayCalls() const { return replayCalls_; }

  // The buffer as it stood when replay ran, so tests can pin the exact
  // compacted-cache shape rather than just its length.
  const std::vector<llama_token>& replayedTokens() const { return replayed_; }

private:
  bool failRestore_ = false;
  bool failReplay_ = false;
  mutable int restoreCalls_ = 0;
  mutable int replayCalls_ = 0;
  mutable std::vector<llama_token> replayed_;
};

} // namespace qvac_test
